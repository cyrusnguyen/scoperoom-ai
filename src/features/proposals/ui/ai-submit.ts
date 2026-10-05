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
