import { Client } from "pg";

export type CleanupTransientResult = { expiredPreviews: number; clearedAppliedBodies: number; deletedReceipts: number };

/** Local operator sweep for transient import bodies and expired receipts; the SQL function enforces the 100-row ceiling. */
export async function cleanupTransient({ dryRun, batchSize }: { dryRun: boolean; batchSize: number }): Promise<CleanupTransientResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("batchSize must be between 1 and 100.");
  const connectionString = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
  if (!connectionString) throw new Error("SCOPEROOM_BOOTSTRAP_DATABASE_URL is required.");
  const target = new URL(connectionString);
  if (!/^postgres(ql)?:$/.test(target.protocol) || !["127.0.0.1", "[::1]", "::1"].includes(target.hostname)) throw new Error("Transient cleanup requires a local target.");
  const expected = process.env.SCOPEROOM_ENVIRONMENT_ID;
  if (!expected) throw new Error("Transient cleanup requires an environment identity.");
  const database = new Client({ connectionString });
  await database.connect();
  try {
    await database.query("BEGIN");
    await database.query("SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '5s'");
    const { rows: [environment] } = await database.query<{ environment_id: string }>("select environment_id::text from app.environment_identity where id=1");
    if (environment?.environment_id !== expected) throw new Error("Transient cleanup rejected environment identity.");
    const { rows: [result] } = await database.query<CleanupTransientResult>("select * from app.cleanup_transient($1, $2)", [dryRun, batchSize]);
    if (!result) throw new Error("Transient cleanup returned no result.");
    await database.query("COMMIT");
    return result;
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    await database.end();
  }
}
