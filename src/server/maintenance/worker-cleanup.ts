import type { PrismaClient } from "../../../prisma/generated/client.ts";
import { getWorkerDatabase } from "../db.ts";

export type WorkerCleanupResult = { expiredPreviews: number; clearedAppliedBodies: number; deletedReceipts: number; expiredAiResults: number; clearedAiBodies: number };
export type WorkerCleanupDatabase = Pick<PrismaClient, "$transaction">;

/**
 * The scheduled worker's cleanup: one bounded sweep (preview and receipt retention plus AI body expiry) through the restricted worker
 * role. The only door is app.run_worker_cleanup, which re-proves the database is this process's environment before it deletes anything.
 * The local operator command (cleanup-transient.ts) keeps its own loopback and bootstrap-credential guard; no bootstrap credential is
 * ever deployed.
 */
export async function workerCleanup(batchSize = 100, db?: WorkerCleanupDatabase): Promise<WorkerCleanupResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new RangeError("batchSize must be between 1 and 100.");
  const environmentId = process.env.SCOPEROOM_ENVIRONMENT_ID;
  if (!environmentId) throw new Error("Worker cleanup requires an environment identity.");
  const sql = db ?? await getWorkerDatabase();
  // A timeout set inside a SQL function cannot arm the already-running statement. Configure it first on this transaction's
  // connection; SET LOCAL also prevents it leaking to later pool users. The client timeout leaves time for SQL to cancel and rollback.
  return sql.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '5s'`;
    const [result] = await tx.$queryRaw<WorkerCleanupResult[]>`SELECT * FROM app.run_worker_cleanup(${environmentId}::uuid, ${batchSize}::integer)`;
    if (!result) throw new Error("Worker cleanup returned no result.");
    return result;
  }, { timeout: 10_000 });
}
