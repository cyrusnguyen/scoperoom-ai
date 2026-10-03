import { after, before } from "node:test";
import { Client } from "pg";

// One advisory-lock key for the whole shared database. Never reused for application locking.
const SWEEP_LOCK = "8305006601";

/**
 * Retention sweeps (cleanup_transient, expire_ai_run_bodies, repairRuns' deadline sweep) are global by design: they take every eligible
 * row, whoever created it. Test files run in parallel against one database, so a file that sweeps would otherwise expire another
 * file's deliberately aged fixtures mid-test (for example the 101 READY previews of transient-cleanup becoming 92). A file that
 * sweeps, or that seeds aged rows a sweep would take, calls this once at top level. Such files then run one at a time, holding one
 * session lock for the whole file (released on exit, or by the server if the process dies); every other file runs unrestricted.
 */
export function serializeSweeps() {
  const url = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
  let holder: Client | undefined;
  before(async () => {
    if (!url) return; // the suite skips without a database; nothing to protect
    holder = new Client({ connectionString: url });
    await holder.connect();
    await holder.query("select pg_advisory_lock($1::bigint)", [SWEEP_LOCK]);
  });
  after(async () => { await holder?.end(); });
}
