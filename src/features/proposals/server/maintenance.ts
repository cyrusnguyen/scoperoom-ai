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

/**
 * Repair then cleanup in one call (Data 04, CI/CD). The two are separately tested services and independent of each other, so a failure in
 * one never skips the other; the first failure is rethrown so the caller records it. Neither can create business intent, extend a deadline
 * or call a model: SQL deadlines stay authoritative when a tick is late. Without a dispatcher the repair cannot deliver, which is reported
 * after cleanup still ran.
 */
export async function runMaintenance(dispatcher: JobDispatcher | undefined, db?: Sql & WorkerCleanupDatabase): Promise<WorkerCleanupResult> {
  let failure: unknown;
  try {
    await repairNow(dispatcher, db);
  } catch (error) {
    failure = error;
  }
  let cleaned: WorkerCleanupResult | undefined;
  try {
    cleaned = await cleanupNow(db);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return cleaned!;
}
