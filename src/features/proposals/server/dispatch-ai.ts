import type { PrismaClient } from "../../../../prisma/generated/client.ts";
import { getWorkerDatabase } from "../../../server/db.ts";
import type { JobDispatcher } from "./ports.ts";

/** The only database surface these services use: raw calls to the narrow SQL functions, on a restricted runtime connection. */
export type Sql = Pick<PrismaClient, "$queryRaw">;

const LEASE_SECONDS = 30;
export type Leased = { runId: string; dispatchId: string; executionBinding: string; deadlineAt: Date; lease: string };

/** SQL dispatch lease: due PENDING runs get an expiring lease inside one short statement; delivery happens afterwards, outside any lock. */
export async function leaseDispatches(db: Sql, runId: string | null, batch: number): Promise<Leased[]> {
  type Row = { out_run_id: string; out_dispatch_id: string; out_execution_binding: string; out_deadline_at: Date; out_lease: string };
  // One named run uses the single-run form (all web may call); the batch form belongs to the worker's repair sweep.
  const rows = runId
    ? await db.$queryRaw<Row[]>`SELECT * FROM app.lease_ai_dispatch(${runId}::uuid, ${LEASE_SECONDS}::integer)`
    : await db.$queryRaw<Row[]>`SELECT * FROM app.lease_ai_dispatches(NULL::uuid, ${batch}::integer, ${LEASE_SECONDS}::integer)`;
  return rows.map((row) => ({ runId: row.out_run_id, dispatchId: row.out_dispatch_id, executionBinding: row.out_execution_binding, deadlineAt: row.out_deadline_at, lease: row.out_lease }));
}

/**
 * Delivers one leased run with its original dispatch id and captured binding, then records the acknowledgement for exactly this lease.
 * Anything short of a clean acceptance (unavailable, thrown, or an acknowledgement that cannot be recorded) leaves the run PENDING
 * until the lease lapses; delivery never grants a provider call, so a duplicate delivery is harmless.
 */
export async function deliver(db: Sql, dispatcher: JobDispatcher, leased: Leased): Promise<void> {
  let reply: Awaited<ReturnType<JobDispatcher["dispatch"]>>;
  try {
    reply = await dispatcher.dispatch({ runId: leased.runId, dispatchId: leased.dispatchId, executionBinding: leased.executionBinding, deadlineAt: leased.deadlineAt.toISOString() });
  } catch {
    return;
  }
  if (reply.kind !== "accepted") return;
  await db.$queryRaw`SELECT app.ack_ai_dispatch(${leased.runId}::uuid, ${leased.dispatchId}::uuid, ${leased.lease}::text, ${reply.taskId}::text)`;
}

/**
 * The best-effort fast path after an admission commit. It never throws for a delivery problem; a database failure surfaces to the
 * caller, which must not let it fail the already committed start. `db` is the caller's own restricted connection (web or worker).
 */
export async function dispatchAi(runId: string, dispatcher: JobDispatcher, db?: Sql): Promise<void> {
  const sql = db ?? await getWorkerDatabase();
  for (const leased of await leaseDispatches(sql, runId, 1)) await deliver(sql, dispatcher, leased);
}
