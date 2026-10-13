import assert from "node:assert/strict";
import test from "node:test";
import { repairFunction, runAiFunction } from "../src/worker/functions.ts";

test("the worker functions keep their pinned settings", () => {
  assert.deepEqual(repairFunction.opts, { id: "repair-runs", retries: 0, concurrency: 1, triggers: [{ cron: "* * * * *" }] });
  assert.deepEqual(runAiFunction.opts, { id: "run-ai", retries: 2, triggers: [{ event: "scoperoom/ai.run.requested" }] });
});
