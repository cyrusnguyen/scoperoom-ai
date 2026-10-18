import { AI_LIMITS, type ConversationTurn, type RunView } from "../contracts/tasks.ts";
import { normalizeEvidence } from "../../sources/contracts/source-version.ts";
import { buildConversation, runTurns } from "../domain/conversation.ts";

export type PendingStartRequest = {
  kind: "start"; projectId: string; draftId: string; key: string; body: Record<string, unknown>; submittedText: string;
};

/** Keep the original object, receipt key and body together until an uncertain admission is resolved. */
export function retryStartRequest<T extends PendingStartRequest>(request: T | null, projectId: string, draftId: string): T | null {
  return request?.projectId === projectId && request.draftId === draftId ? request : null;
}

/** Acknowledgement clears only the submitted value; newer typing belongs to the next deliberate action. */
export function acknowledgedInstruction(current: string, submitted: string): string {
  return current === submitted ? "" : current;
}

/** "continue" the current run, start "fresh", or reuse the current run's own "parent" answer (Regenerate sends the same request again). */
export type ThreadMode = "continue" | "fresh" | "parent";

/**
 * Which run a new instruction continues, and the turns it will carry. A run that answered is continued itself; a follow-up that
 * failed or is still running keeps continuing the answer it continued, so one failure never silently drops the thread.
 * The shown turns are trimmed by the same buildConversation admission uses, so the panel shows exactly what is sent.
 */
export function followUpThread(run: Pick<RunView, "id" | "state" | "result" | "capture" | "disposition"> | null, mode: ThreadMode): { runId: string; turns: ConversationTurn[] } | null {
  if (!run || mode === "fresh") return null;
  if (mode === "continue" && run.state === "SUCCEEDED" && run.result && run.capture) {
    const continued = { id: run.id, capture: run.capture, result: run.result, disposition: run.disposition };
    // Too long to send even alone: show it anyway, so the server refusal can be recovered with "Start a new conversation".
    try { return { runId: run.id, turns: buildConversation(continued).turns }; } catch { return { runId: run.id, turns: runTurns(continued) }; }
  }
  const earlier = run.capture?.conversation;
  return earlier ? { runId: earlier.continuesRunId, turns: earlier.turns } : null;
}

/** The server counts the normalized instruction in code points; refusing here keeps the Studio save and the request from being sent. */
export function instructionError(text: string): string | null {
  return Array.from(normalizeEvidence(text)).length > AI_LIMITS.promptCodePoints ? `Instruction must be ${AI_LIMITS.promptCodePoints.toLocaleString("en-US")} characters or fewer.` : null;
}

/** A refused start: a request too large for the model says what to change; anything else keeps the server message. */
export function startRefusalText(result: { code: string; message: string; details?: Record<string, unknown> }): string {
  if (result.code === "LIMIT_EXCEEDED" && result.details?.limit === "INPUT_TOKENS") return "This request was refused because it is too large for the AI. Select fewer steps, shorten the instruction or start a new conversation.";
  return result.message || "The AI request was refused. Your instruction is still here.";
}
