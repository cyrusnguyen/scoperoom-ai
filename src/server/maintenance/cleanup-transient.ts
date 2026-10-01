import { Client } from "pg";

export type CleanupTransientResult = { expiredPreviews: number; clearedAppliedBodies: number; deletedReceipts: number };

/** Local operator sweep for transient import bodies and expired receipts; the SQL function enforces the 100-row ceiling. */
export async function cleanupTransient({ dryRun, batchSize }: { dryRun: boolean; batchSize: number }): Promise<CleanupTransientResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("batchSize must be between 1 and 100.");
  const connectionString = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
  if (!connectionString) throw new Error("SCOPEROOM_BOOTSTRAP_DATABASE_URL is required.");
  const database = new Client({ connectionString });
  await database.connect();
  try {
    const { rows: [result] } = await database.query<CleanupTransientResult>("select * from app.cleanup_transient($1, $2)", [dryRun, batchSize]);
    if (!result) throw new Error("Transient cleanup returned no result.");
    return result;
  } finally {
    await database.end();
  }
}
