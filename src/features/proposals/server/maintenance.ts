import { workerCleanup, type WorkerCleanupDatabase, type WorkerCleanupResult } from "../../../server/maintenance/worker-cleanup.ts";
import type { JobDispatcher } from "./ports.ts";
import { repairRuns } from "./repair-runs.ts";
import type { Sql } from "./dispatch-ai.ts";

const REPAIR_BATCH = 50;
const CLEANUP_BATCH = 100;

/** Due-run repair only. Without a dispatcher it cannot deliver, which is an error the caller reports. */
export async function repairNow(dispatcher: JobDispatcher | undefined, db?: Sql): Promise<void> {
  if (!dispatcher) throw new Error("INNGEST_EVENT_KEY is required to repair AI dispatch.");
  await repairRuns(dispatcher, { batchSize: REPAIR_BATCH }, db);
}

/** The bounded transient and AI body cleanup only. */
export function cleanupNow(db?: WorkerCleanupDatabase): Promise<WorkerCleanupResult> {
  return workerCleanup(CLEANUP_BATCH, db);
}
