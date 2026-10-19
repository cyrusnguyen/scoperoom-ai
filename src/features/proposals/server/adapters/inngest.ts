import type { JobDispatcher, JobRequest } from "../ports.ts";

export const RUN_AI_EVENT = "scoperoom/ai.run.requested";
export const INNGEST_APP_ID = "scoperoom";
/** Mirrors the 128-character limit admission applies to the execution binding. */
export const BINDING_MAX = 128;

/** The narrow slice of the Inngest client this adapter uses, so tests inject a fake and nothing else sees SDK types. */
export type EventSender = { send(event: { name: string; id: string; data: JobRequest }): Promise<{ ids: string[] }> };

/**
 * One dispatcher over Inngest events. `dispatchId` is the event id, so a repeated delivery of the same SQL intent is dropped by Inngest;
 * the payload carries identities and the deadline only. Any failure is `unavailable`: SQL stays PENDING and repair re-sends.
 */
export function createJobDispatcher(sender: EventSender): JobDispatcher {
  return {
    async dispatch(request) {
      if (!(Date.parse(request.deadlineAt) > Date.now()) || request.executionBinding.length > BINDING_MAX) return { kind: "unavailable" };
      try {
        const { ids } = await sender.send({ name: RUN_AI_EVENT, id: request.dispatchId,
          data: { runId: request.runId, dispatchId: request.dispatchId, executionBinding: request.executionBinding, deadlineAt: request.deadlineAt } });
        return ids[0] ? { kind: "accepted", taskId: ids[0] } : { kind: "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
