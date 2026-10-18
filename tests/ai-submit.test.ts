import assert from "node:assert/strict";
import { test } from "node:test";
import { acknowledgedInstruction, followUpThread, instructionError, retryStartRequest, startRefusalText } from "../src/features/proposals/ui/ai-submit.ts";
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

test("the shown thread drops whole older runs by bytes exactly as admission does", () => {
  // Two-byte characters: three 10,000-byte instructions exceed the 24 KiB bound within 6 turns, so the oldest run must go.
  const big = (id: string, text: string) => [{ runId: id, role: "user" as const, text }, { runId: id, role: "assistant" as const, text: "ok" }];
  const older = "33333333-3333-4333-8333-333333333333";
  const conversation = { continuesRunId: earlierId, turns: [...big(older, "é".repeat(5_000)), ...big(earlierId, "è".repeat(5_000))] };
  const thread = followUpThread(view({ capture: { prompt: "ê".repeat(5_000), conversation } as CapturedInput }), "continue");
  assert.deepEqual([...new Set(thread?.turns.map((turn) => turn.runId))], [earlierId, runId]);
});

test("a continued run too long to send still shows its thread, so the server's refusal can be recovered with Start a new conversation", () => {
  const thread = followUpThread(view({ capture: { prompt: "😀".repeat(8_000) } as CapturedInput }), "continue");
  assert.equal(thread?.runId, runId);
  assert.equal(thread?.turns.length, 2);
});

test("the instruction limit matches the server: normalized code points, not UTF-16 units", () => {
  assert.equal(instructionError("😀".repeat(8_000)), null, "8,000 emoji are 16,000 UTF-16 units but 8,000 code points");
  assert.equal(instructionError("a\r\n".repeat(4_000)), null, "CRLF counts as one line break, as the server normalizes it");
  assert.match(instructionError("a".repeat(8_001)) ?? "", /8,000 characters or fewer/);
});

test("a request too large for the model says what to change, and other refusals keep the server message", () => {
  assert.match(startRefusalText({ code: "LIMIT_EXCEEDED", message: "This draft has reached a size limit.", details: { limit: "INPUT_TOKENS" } }), /refused because it is too large for the AI/);
  assert.equal(startRefusalText({ code: "LIMIT_EXCEEDED", message: "This draft has reached a size limit.", details: { limit: "APPLICABLE_PROPOSALS" } }), "This draft has reached a size limit.");
  assert.equal(startRefusalText({ code: "FORBIDDEN", message: "" }), "The AI request was refused. Your instruction is still here.");
});
