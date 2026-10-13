import assert from "node:assert/strict";
import test from "node:test";
import { repairFunction, repairSweep, runAiFunction } from "../src/worker/functions.ts";

test("the worker functions keep their pinned settings", () => {
  assert.deepEqual(repairFunction.opts, { id: "repair-runs", retries: 0, concurrency: 1, triggers: [{ cron: "*/2 * * * *" }] });
  assert.deepEqual(runAiFunction.opts, { id: "run-ai", retries: 2, triggers: [{ event: "scoperoom/ai.run.requested" }] });
});

test("a repair sweep returns its counts, and reports a failure as a result so consecutive failures never pause the cron", async (t) => {
  const error = t.mock.method(console, "error", () => undefined);
  assert.deepEqual(await repairSweep(async () => 3), { ok: true, cleaned: 3 });
  assert.equal(error.mock.callCount(), 0);
  assert.deepEqual(await repairSweep(async () => { throw new Error("password=secret host=db"); }), { ok: false });
  assert.deepEqual(error.mock.calls.map((call) => call.arguments), [[JSON.stringify({ maintenance: "failed" })]]);
});
