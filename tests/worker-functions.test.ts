import assert from "node:assert/strict";
import test from "node:test";
import { runAiFunction } from "../src/worker/functions.ts";

test("the worker function keeps its pinned settings", () => {
  assert.deepEqual(runAiFunction.opts, { id: "run-ai", retries: 2, triggers: [{ event: "scoperoom/ai.run.requested" }] });
});
