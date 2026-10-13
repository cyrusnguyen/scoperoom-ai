import assert from "node:assert/strict";
import test from "node:test";
import { JOBS, probeJob, scheduleCommand } from "../scripts/db/schedule.mjs";

test("the jobs are repair every minute and cleanup hourly", () => {
  assert.deepEqual(JOBS, [
    { name: "scoperoom-repair", schedule: "* * * * *", path: "/api/internal/worker/repair" },
    { name: "scoperoom-cleanup", schedule: "0 * * * *", path: "/api/internal/worker/cleanup" },
  ]);
});

test("the cron command posts to the worker endpoint and reads the secret from Vault at run time", () => {
  const sql = scheduleCommand("https://worker.example.test", "/api/internal/worker/repair");
  assert.match(sql, /net\.http_post\(url := 'https:\/\/worker\.example\.test\/api\/internal\/worker\/repair'/);
  assert.match(sql, /vault\.decrypted_secrets where name = 'scoperoom_worker_secret'/);
  assert.doesNotMatch(sql, /Bearer [A-Za-z0-9]/, "no secret value in the command text");
});

test("only a bare https origin and a known path are accepted, so nothing can be injected", () => {
  for (const bad of ["http://worker.example.test", "https://worker.example.test/path", "https://worker.example.test?x=1", "https://w'orker.example.test", "https://user:pw@worker.example.test", "not a url"]) {
    assert.throws(() => scheduleCommand(bad, "/api/internal/worker/repair"), /bare https origin/, bad);
  }
  assert.throws(() => scheduleCommand("https://worker.example.test", "/api/internal/worker/x'); drop table app.project; --"), /known maintenance path/);
});

test("verify probes each endpoint with its own job command and needs that request's 202", async () => {
  const origin = "https://worker.example.test", job = JOBS[1]!;
  const fake = (responses: Array<Record<string, unknown> | undefined>) => {
    const sent: string[] = [];
    return { sent, query: async (sql: string) => { sent.push(sql); return { rows: sql.startsWith("select net.http_post") ? [{ id: 7 }] : [responses.shift()].filter(Boolean) }; } };
  };
  const ok = fake([undefined, { status_code: 202, error_msg: null }]);
  await probeJob(ok, origin, job, { attempts: 3, wait: async () => {} });
  assert.equal(ok.sent[0], `${scheduleCommand(origin, job.path)} as id`);
  assert.equal(ok.sent.length, 3, "polls the request id until its response lands");
  await assert.rejects(probeJob(fake([{ status_code: 404, error_msg: null }]), origin, job, { attempts: 3, wait: async () => {} }), /scoperoom-cleanup answered 404/);
  await assert.rejects(probeJob(fake([{ status_code: null, error_msg: "Timeout" }]), origin, job, { attempts: 3, wait: async () => {} }), /scoperoom-cleanup answered no status \(Timeout\)/);
  await assert.rejects(probeJob(fake([]), origin, job, { attempts: 2, wait: async () => {} }), /scoperoom-cleanup got no response/);
});
