import type { Client } from "pg";

/**
 * Waits until `ready` accepts the queries of the sessions waiting on a lock behind `holderPid`, directly or through another waiter.
 * Only this holder's chain counts, so sessions from files running in parallel cannot satisfy it.
 */
export async function waitForLockWaiters(database: Client, holderPid: number, ready: (queries: string[]) => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  let queries: string[] = [];
  while (Date.now() < deadline) {
    const result = await database.query<{ query: string }>(`
      with recursive holder_chain(pid) as (
        select $1::int
        union
        select waiting.pid from pg_stat_activity waiting
        join holder_chain blocker on blocker.pid = any(pg_blocking_pids(waiting.pid))
      )
      select activity.query from pg_stat_activity activity
      join holder_chain on holder_chain.pid = activity.pid
      where activity.wait_event_type = 'Lock'`, [holderPid]);
    queries = result.rows.map((row) => row.query);
    if (ready(queries)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${queries.join(" | ")}`);
}

export const countLockQueries = (queries: string[], fragment: string) => queries.filter((query) => query.includes(fragment)).length;
