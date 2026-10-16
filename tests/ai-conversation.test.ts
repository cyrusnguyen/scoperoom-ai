import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AI_LIMITS, type CapturedInput, type ValidatedProposal } from "../src/features/proposals/contracts/tasks.ts";
import { buildConversation, conversationBytes, parseConversation, runTurns, summarizeResult, type ContinuedRun } from "../src/features/proposals/domain/conversation.ts";

const clarification: ValidatedProposal = { schemaVersion: 1, kind: "clarification", message: "Which payment methods should checkout support?" };
const proposal: ValidatedProposal = { schemaVersion: 1, kind: "proposal", operations: [
  { id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW", payload: { ref: "flow", title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } } },
  { id: "pay", dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: "pay", flowId: "flow", kind: "ACTION", label: "Pay", description: "", actorLabel: "Customer" } } },
], assumptions: ["Cards only"], citations: [] };

// Only the fields the conversation code reads; the rest of a capture is irrelevant here.
const run = (prompt: string, result: ValidatedProposal, earlier?: CapturedInput["conversation"]): ContinuedRun => ({
  id: randomUUID(), result, disposition: "AVAILABLE",
  capture: { prompt, ...(earlier ? { conversation: earlier } : {}) } as CapturedInput,
});

test("a clarification answer is carried word for word", () => {
  assert.equal(summarizeResult(clarification, "AVAILABLE"), clarification.message);
});

test("a proposal answer is summarized with its outcome, changes and assumptions", () => {
  assert.equal(summarizeResult(proposal, "APPLIED"), 'Proposed 2 change(s), applied to the draft:\n- create flow "Checkout"\n- add step "Pay"\nAssumptions: Cards only');
  assert.match(summarizeResult(proposal, "DISCARDED"), /, discarded:/);
  assert.match(summarizeResult(proposal, null), /, not applied yet:/);
});

test("a long proposal summary lists 20 changes, counts the rest and stays within the summary bound", () => {
  const many: ValidatedProposal = { ...proposal, kind: "proposal", operations: Array.from({ length: 30 }, (_, index) => ({
    id: `s${index}`, dependsOn: [], edit: { command: "ADD_NODE" as const, payload: { ref: `s${index}`, flowId: "flow", kind: "ACTION" as const, label: "x".repeat(150), description: "", actorLabel: "" } },
  })) };
  const summary = summarizeResult(many, "AVAILABLE");
  assert.ok(Array.from(summary).length <= AI_LIMITS.turnSummaryCodePoints);
  assert.ok(summary.endsWith("…"));
  const shortLabels: ValidatedProposal = { ...many, operations: many.operations.map((operation) => ({
    ...operation, edit: { command: "ADD_NODE" as const, payload: { ref: operation.id, flowId: "flow", kind: "ACTION" as const, label: "Pay", description: "", actorLabel: "" } },
  })) };
  assert.ok(summarizeResult(shortLabels, "AVAILABLE").includes("\n- and 10 more"));
});

test("runTurns appends the run's own instruction and answer after its earlier turns", () => {
  const first = run("Make a checkout flow", clarification);
  const second = run("Cards and PayPal", proposal, buildConversation(first));
  assert.deepEqual(runTurns(second).map((turn) => [turn.runId, turn.role]), [
    [first.id, "user"], [first.id, "assistant"], [second.id, "user"], [second.id, "assistant"],
  ]);
  assert.equal(runTurns(second)[2]!.text, "Cards and PayPal");
});

test("buildConversation drops whole earlier runs, oldest first, to stay within the turn limit", () => {
  let current = run("turn 0", clarification);
  const ids = [current.id];
  for (let index = 1; index < 10; index++) {
    current = run(`turn ${index}`, clarification, buildConversation(current));
    ids.push(current.id);
  }
  const built = buildConversation(current);
  assert.equal(built.continuesRunId, current.id);
  assert.equal(built.turns.length, AI_LIMITS.conversationTurns);
  assert.deepEqual([...new Set(built.turns.map((turn) => turn.runId))], ids.slice(-AI_LIMITS.conversationTurns / 2));
});

test("buildConversation drops old runs for the byte bound but refuses when the continued run alone is too long", () => {
  // "é" is two UTF-8 bytes: three 10,000-byte instructions exceed 24 KiB, two fit.
  const big = run("é".repeat(5_000), clarification);
  const next = run("è".repeat(5_000), clarification, buildConversation(big));
  const built = buildConversation(run("ê".repeat(5_000), clarification, buildConversation(next)));
  assert.equal(new Set(built.turns.map((turn) => turn.runId)).size, 2);
  assert.ok(conversationBytes(built.turns) <= AI_LIMITS.conversationBytes);
  assert.ok(!built.turns.some((turn) => turn.runId === big.id), "the oldest run went first");
  assert.throws(() => buildConversation(run("😀".repeat(8_000), clarification)), { message: "LIMIT_EXCEEDED" });
});

test("parseConversation accepts what buildConversation stores and rejects anything else", () => {
  const built = buildConversation(run("Make a checkout flow", clarification));
  assert.deepEqual(parseConversation(JSON.parse(JSON.stringify(built))), built);
  const bad = (raw: unknown) => assert.throws(() => parseConversation(raw), { message: "INVALID_INPUT" });
  bad({ ...built, extra: true });
  bad({ ...built, turns: [] });
  bad({ ...built, continuesRunId: randomUUID() }); // last turn must belong to the continued run
  bad({ ...built, turns: [...built.turns].reverse() }); // must end with the answer
  bad({ ...built, turns: built.turns.map((turn) => ({ ...turn, role: "system" })) });
  bad({ ...built, turns: built.turns.map((turn) => ({ ...turn, text: "" })) });
  bad({ ...built, turns: Array.from({ length: AI_LIMITS.conversationTurns + 2 }, (_, index) => ({ runId: built.continuesRunId, role: index % 2 ? "assistant" : "user", text: "Hi" })) }); // too many turns
  bad({ ...built, turns: ["user", "assistant"].map((role) => ({ runId: built.continuesRunId, role, text: "😀".repeat(4_000) })) }); // 32,000 bytes: each turn is within the prompt bound, together they are over the byte bound
});
