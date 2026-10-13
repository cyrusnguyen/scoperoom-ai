import { cleanupNow, repairNow } from "../features/proposals/server/maintenance.ts";
import { jobDispatcher } from "../features/proposals/server/providers.ts";

export type ScheduledTask = "repair" | "cleanup";
const defaults: Record<ScheduledTask, () => Promise<unknown>> = { repair: () => repairNow(jobDispatcher()), cleanup: () => cleanupNow() };

/**
 * One pg_cron-triggered sweep. A failure is a reported result, never a throw (the next tick retries); the log line carries the task,
 * the outcome and counts only, never error text or data.
 */
export async function runScheduled(task: ScheduledTask, run: () => Promise<unknown> = defaults[task]): Promise<{ ok: boolean }> {
  try {
    const counts = await run();
    console.info(JSON.stringify({ maintenance: task, ok: true, ...(counts && typeof counts === "object" ? { counts } : {}) }));
    return { ok: true };
  } catch {
    console.error(JSON.stringify({ maintenance: task, ok: false }));
    return { ok: false };
  }
}
