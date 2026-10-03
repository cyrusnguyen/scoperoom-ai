import { getWorkerDatabase } from "../../../server/db.ts";
import { deliver, leaseDispatches, type Sql } from "./dispatch-ai.ts";
import type { JobDispatcher } from "./ports.ts";
import { finishRun } from "./run-ai.ts";

/**
 * One bounded repair sweep (Data 04): settle runs past their SQL deadline (a never-claimed reservation is refunded once), settle
 * cancel-requested runs that may now settle (nudging their task, best effort), then lease and deliver due PENDING dispatches with
 * the original dispatch id and binding. Every step is its own short statement; a failure in one run does not stop the rest and is
 * rethrown at the end so the scheduler records it.
 */
export async function repairRuns(dispatcher: JobDispatcher, { batchSize }: { batchSize: number }, db?: Sql): Promise<void> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new RangeError("batchSize must be an integer from 1 to 100.");
  const sql = db ?? await getWorkerDatabase();
  let failure: unknown;
  const guarded = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failure ??= error; } };

  const overdue = await sql.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM app.ai_run WHERE state IN ('QUEUED', 'RUNNING', 'VALIDATING') AND deadline_at <= clock_timestamp() ORDER BY deadline_at, id LIMIT ${batchSize}::integer`;
  for (const { id } of overdue) await guarded(() => finishRun(sql, id, "TIMED_OUT", null));

  const cancelling = await sql.$queryRaw<Array<{ id: string; task_id: string | null }>>`
    SELECT id, task_id FROM app.ai_run WHERE state IN ('QUEUED', 'RUNNING', 'VALIDATING') AND cancel_requested_at IS NOT NULL ORDER BY cancel_requested_at, id LIMIT ${batchSize}::integer`;
  for (const { id, task_id: taskId } of cancelling) {
    await guarded(() => finishRun(sql, id, "CANCELLED", null)); // refused while a call window is open; the deadline or the worker settles it
    if (taskId) await guarded(() => dispatcher.cancel(taskId)); // `requested` never settles anything by itself
  }

  for (const leased of await leaseDispatches(sql, null, batchSize)) await guarded(() => deliver(sql, dispatcher, leased));
  if (failure) throw failure;
}
