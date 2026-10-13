import { Client } from "pg";
import { targetInput, targetKind, verifyTarget } from "./guard.mjs";

// Hosted-only operator setup for the worker maintenance schedule: Supabase pg_cron calls the worker's secret-protected endpoints through
// pg_net, the bearer read from Vault when each job runs.
//   apply   installs the extensions, stores the secret in Vault and (re)creates both jobs
//   verify  both jobs active with the expected schedule and command, and each endpoint answers a probe of its own command with 202
const SECRET_NAME = "scoperoom_worker_secret";
export const JOBS = [
  { name: "scoperoom-repair", schedule: "* * * * *", path: "/api/internal/worker/repair" },
  { name: "scoperoom-cleanup", schedule: "0 * * * *", path: "/api/internal/worker/cleanup" },
];

/** The pg_cron command: an async pg_net POST to one worker maintenance endpoint, the bearer read from Vault when the job runs. */
export function scheduleCommand(origin, path) {
  let url;
  try { url = new URL(origin); } catch { throw new Error("Schedule needs the worker's bare https origin."); }
  if (url.protocol !== "https:" || url.origin !== origin.replace(/\/$/, "") || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new Error("Schedule needs the worker's bare https origin.");
  if (!JOBS.some((job) => job.path === path)) throw new Error("Schedule needs a known maintenance path.");
  return `select net.http_post(url := '${url.origin}${path}', body := '{}'::jsonb, timeout_milliseconds := 10000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${SECRET_NAME}')))`;
}

async function apply(client) {
  const origin = process.env.SCOPEROOM_WORKER_URL?.trim() ?? "", secret = process.env.SCOPEROOM_WORKER_SECRET;
  if (!secret || secret.length < 32) throw new Error("Schedule needs a SCOPEROOM_WORKER_SECRET of at least 32 characters.");
  const commands = JOBS.map((job) => [job, scheduleCommand(origin, job.path)]);
  await client.query("create extension if not exists pg_cron with schema pg_catalog");
  await client.query("create extension if not exists pg_net with schema extensions");
  const { rows: [existing] } = await client.query("select id from vault.secrets where name = $1", [SECRET_NAME]);
  if (existing) await client.query("select vault.update_secret($1, $2)", [existing.id, secret]);
  else await client.query("select vault.create_secret($1, $2)", [secret, SECRET_NAME]);
  for (const [job, command] of commands) {
    await client.query("select cron.unschedule(jobid) from cron.job where jobname = $1", [job.name]);
    await client.query("select cron.schedule($1, $2, $3)", [job.name, job.schedule, command]);
  }
}

/**
 * Runs one job's exact command now and waits for that request's response: a 202 proves the endpoint, the origin and the Vault secret.
 * net._http_response has no URL, so only the returned request id ties a response to a job.
 */
export async function probeJob(client, origin, job, { attempts = 30, wait = () => new Promise((resolve) => setTimeout(resolve, 1_000)) } = {}) {
  const { rows: [{ id }] } = await client.query(`${scheduleCommand(origin, job.path)} as id`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { rows: [response] } = await client.query("select status_code, error_msg from net._http_response where id = $1", [id]);
    if (response) {
      if (response.status_code === 202) return;
      throw new Error(`${job.name} answered ${response.status_code ?? `no status (${response.error_msg})`}.`);
    }
    await wait();
  }
  throw new Error(`${job.name} got no response within ${attempts} checks.`);
}

/** Both jobs active with the expected schedule and command, and each endpoint answers its own probe with 202. */
async function verify(client) {
  const origin = process.env.SCOPEROOM_WORKER_URL?.trim() ?? "";
  for (const job of JOBS) {
    const { rows: [row] } = await client.query("select schedule, active, command from cron.job where jobname = $1", [job.name]);
    if (!row || !row.active || row.schedule !== job.schedule || row.command !== scheduleCommand(origin, job.path)) throw new Error(`${job.name} is missing, inactive or differs.`);
  }
  for (const job of JOBS) await probeJob(client, origin, job);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (!["apply", "verify"].includes(command)) throw new Error("Usage: schedule.mjs apply | verify");
  if (targetKind() !== "hosted") throw new Error("The maintenance schedule is hosted-only; local and CI never schedule.");
  await verifyTarget("bound");
  const client = new Client({ connectionString: targetInput().connectionString });
  await client.connect();
  try { await (command === "apply" ? apply(client) : verify(client)); } finally { await client.end(); }
  console.log(`schedule=${command}-ok`);
}
