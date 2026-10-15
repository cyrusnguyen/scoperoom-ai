import { AI_LIMITS, type ConversationTurn, type RunView } from "../contracts/tasks.ts";
import { runTurns } from "../domain/conversation.ts";

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

/**
 * Which run a new instruction continues, and the turns it will carry. A run that answered is continued itself; a follow-up that
 * failed or is still running keeps continuing the answer it continued, so one failure never silently drops the thread.
 * The server trims the oldest turns to its turn and byte bounds; the UI mirrors only the turn-count bound, not the byte bound.
 */
export function followUpThread(run: Pick<RunView, "id" | "state" | "result" | "capture" | "disposition"> | null, startFresh: boolean): { runId: string; turns: ConversationTurn[] } | null {
  if (!run || startFresh) return null;
  if (run.state === "SUCCEEDED" && run.result && run.capture) {
    return { runId: run.id, turns: runTurns({ id: run.id, capture: run.capture, result: run.result, disposition: run.disposition }).slice(-AI_LIMITS.conversationTurns) };
  }
  const earlier = run.capture?.conversation;
  return earlier ? { runId: earlier.continuesRunId, turns: earlier.turns } : null;
}
