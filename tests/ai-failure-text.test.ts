import assert from "node:assert/strict";
import { test } from "node:test";
import { failureText } from "../src/features/proposals/domain/failure-text.ts";

test("a step-limit refusal tells the person what to change", () => {
  assert.equal(failureText("RESULT_GRAPH_LIMIT"), "The AI proposed more than 20 new steps or 40 new connections, which is over the limit. Ask for fewer steps and try again.");
});

test("other failures keep their safe code in plain words", () => {
  assert.equal(failureText("RESULT_REFERENCE"), "The provider could not complete this run (result reference).");
  assert.equal(failureText(null), "The provider could not complete this run.");
});
