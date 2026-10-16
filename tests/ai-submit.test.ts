import assert from "node:assert/strict";
import { test } from "node:test";
import { acknowledgedInstruction, followUpThread, retryStartRequest } from "../src/features/proposals/ui/ai-submit.ts";
import type { CapturedInput, RunView } from "../src/features/proposals/contracts/tasks.ts";

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

const earlierId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const earlier = { continuesRunId: earlierId, turns: [
  { runId: earlierId, role: "user" as const, text: "Make a checkout flow" }, { runId: earlierId, role: "assistant" as const, text: "Which payment methods?" }] };
const view = (over: Partial<RunView>) => ({ id: runId, state: "SUCCEEDED", disposition: "AVAILABLE", capture: { prompt: "Cards", conversation: earlier } as CapturedInput,
  result: { schemaVersion: 1, kind: "clarification", message: "Guest checkout too?" }, ...over }) as Pick<RunView, "id" | "state" | "result" | "capture" | "disposition">;

test("a succeeded run is continued with its earlier turns plus its own instruction and answer", () => {
  const thread = followUpThread(view({}), "continue");
  assert.equal(thread?.runId, runId);
  assert.deepEqual(thread?.turns.map((turn) => turn.text), ["Make a checkout flow", "Which payment methods?", "Cards", "Guest checkout too?"]);
});

test("a failed follow-up keeps continuing the answer it continued", () => {
  const thread = followUpThread(view({ state: "FAILED", result: null }), "continue");
  assert.deepEqual(thread, { runId: earlierId, turns: earlier.turns });
});

test("no thread when starting fresh, with no run, or once the capture expired", () => {
  assert.equal(followUpThread(view({}), "fresh"), null);
  assert.equal(followUpThread(null, "continue"), null);
  assert.equal(followUpThread(view({ capture: null, result: null, disposition: "EXPIRED" }), "continue"), null);
  assert.equal(followUpThread(view({ state: "FAILED", result: null, capture: { prompt: "x" } as CapturedInput }), "continue"), null);
});

test("regenerating a follow-up continues the same earlier answer; regenerating a first run starts fresh", () => {
  assert.deepEqual(followUpThread(view({}), "parent"), { runId: earlierId, turns: earlier.turns });
  assert.equal(followUpThread(view({ capture: { prompt: "Make a checkout flow" } as CapturedInput }), "parent"), null);
});
