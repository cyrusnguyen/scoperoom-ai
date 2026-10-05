import assert from "node:assert/strict";
import { test } from "node:test";
import { acknowledgedInstruction, retryStartRequest } from "../src/features/proposals/ui/ai-submit.ts";

const request = {
  kind: "start" as const, projectId: "project-a", draftId: "draft-a", key: "stable-key",
  body: { taskType: "PROPOSE_FLOW", prompt: "first text", draftId: "draft-a" }, submittedText: "first text",
};

test("a lost admission acknowledgement retries the identical project, key and body", () => {
  const retry = retryStartRequest(request, "project-a", "draft-a");
  assert.equal(retry, request);
  assert.equal(retry?.key, "stable-key");
  assert.equal(retry?.body, request.body);
  assert.equal(retry?.submittedText, "first text");
});

test("a pending request cannot be replayed into another project or replacement draft", () => {
  assert.equal(retryStartRequest(request, "project-b", "draft-a"), null);
  assert.equal(retryStartRequest(request, "project-a", "draft-b"), null);
});

test("acknowledgement clears only the submitted instruction, preserving text typed while sending", () => {
  assert.equal(acknowledgedInstruction("first text", request.submittedText), "");
  assert.equal(acknowledgedInstruction("newer text", request.submittedText), "newer text");
});
