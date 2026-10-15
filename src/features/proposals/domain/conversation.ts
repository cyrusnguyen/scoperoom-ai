import { id, invalid, keys, object, oneOf, text } from "../../drafts/contracts/strict.ts";
import { AI_LIMITS, type CapturedConversation, type CapturedInput, type ConversationTurn, type ProposalEdit, type RunDisposition, type ValidatedProposal } from "../contracts/tasks.ts";

// Browser-safe (no node: imports): the AI panel reuses runTurns to show the thread a new instruction continues.

/** A succeeded run whose capture and answer were already validated (inspectRun). */
export type ContinuedRun = { id: string; capture: CapturedInput; result: ValidatedProposal; disposition: RunDisposition | null };

const SHOWN_OPERATIONS = 20;
const OUTCOME = { AVAILABLE: "not applied yet", APPLIED: "applied to the draft", DISCARDED: "discarded", EXPIRED: "expired" } as const;

function describe(edit: ProposalEdit): string {
  switch (edit.command) {
    case "CREATE_FLOW": return `create flow "${edit.payload.title}"`;
    case "ADD_NODE": return `add step "${edit.payload.label}"`;
    case "UPDATE_NODE": return edit.payload.label === undefined ? `update step ${edit.payload.nodeId}` : `update step ${edit.payload.nodeId} to "${edit.payload.label}"`;
    case "DELETE_NODES": return `delete ${edit.payload.nodeIds.length} step(s)`;
    case "ADD_EDGE": return `connect ${edit.payload.fromId} to ${edit.payload.toId}`;
    case "UPDATE_EDGE": return `change the condition on ${edit.payload.edgeId}`;
    case "RECONNECT_EDGE": return `reconnect ${edit.payload.edgeId} from ${edit.payload.fromId} to ${edit.payload.toId}`;
    case "DELETE_EDGE": return `remove connection ${edit.payload.edgeId}`;
  }
}

/**
 * What the model answered, as one turn. A clarification is carried word for word (validateResult bounds it to 2,000 code points).
 * A proposal is summarized: derived text, so it is shortened to the bound rather than refusing the follow-up.
 */
export function summarizeResult(result: ValidatedProposal, disposition: RunDisposition | null): string {
  if (result.kind === "clarification") return result.message;
  const lines = result.operations.slice(0, SHOWN_OPERATIONS).map((operation) => `- ${describe(operation.edit)}`);
  if (result.operations.length > SHOWN_OPERATIONS) lines.push(`- and ${result.operations.length - SHOWN_OPERATIONS} more`);
  if (result.assumptions.length) lines.push(`Assumptions: ${result.assumptions.join("; ")}`);
  const summary = [`Proposed ${result.operations.length} change(s), ${OUTCOME[disposition ?? "AVAILABLE"]}:`, ...lines].join("\n");
  const points = Array.from(summary);
  return points.length <= AI_LIMITS.turnSummaryCodePoints ? summary : `${points.slice(0, AI_LIMITS.turnSummaryCodePoints - 1).join("")}…`;
}

/** The earlier turns a run carries, then its own instruction and answer, oldest first. */
export function runTurns(run: ContinuedRun): ConversationTurn[] {
  return [
    ...(run.capture.conversation?.turns ?? []),
    { runId: run.id, role: "user", text: run.capture.prompt },
    { runId: run.id, role: "assistant", text: summarizeResult(run.result, run.disposition) },
  ];
}

/** Compact JSON bytes. The whole capture is still bounded separately by AI_LIMITS.captureBytes as PostgreSQL measures it. */
export const conversationBytes = (turns: ConversationTurn[]): number => new TextEncoder().encode(JSON.stringify(turns)).length;

/** Drops whole earlier runs, oldest first, until both bounds hold. The continued run is never dropped or cut: too long refuses. */
export function buildConversation(run: ContinuedRun): CapturedConversation {
  let turns = runTurns(run);
  while (turns.length > AI_LIMITS.conversationTurns || conversationBytes(turns) > AI_LIMITS.conversationBytes) {
    const oldest = turns[0]!.runId;
    if (oldest === run.id) throw new Error("LIMIT_EXCEEDED");
    turns = turns.filter((turn) => turn.runId !== oldest);
  }
  return { continuesRunId: run.id, turns };
}

/** Strict check of a stored conversation before it is trusted again; any deviation throws INVALID_INPUT. */
export function parseConversation(raw: unknown): CapturedConversation {
  const value = object(raw);
  keys(value, ["continuesRunId", "turns"]);
  const continuesRunId = id(value.continuesRunId);
  if (!Array.isArray(value.turns) || value.turns.length < 2 || value.turns.length > AI_LIMITS.conversationTurns) invalid();
  const turns = value.turns.map((entry): ConversationTurn => {
    const turn = object(entry);
    keys(turn, ["runId", "role", "text"]);
    return { runId: id(turn.runId), role: oneOf(turn.role, ["user", "assistant"] as const), text: text(turn.text, AI_LIMITS.promptCodePoints, true) };
  });
  const last = turns.at(-1)!;
  if (last.runId !== continuesRunId || last.role !== "assistant" || conversationBytes(turns) > AI_LIMITS.conversationBytes) invalid();
  return { continuesRunId, turns };
}
