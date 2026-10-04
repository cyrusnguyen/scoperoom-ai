import { TriggerClient } from "@trigger.dev/sdk";
import type { JobDispatcher, JobRequest } from "../ports.ts";

export const RUN_AI_TASK_ID = "run-ai";
export const EXTERNAL_ID_MAX = 128;
const FINISHED = new Set(["COMPLETED", "CANCELED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "INTERRUPTED", "EXPIRED", "TIMED_OUT"]);

/** The narrow slice of the Trigger SDK this adapter uses, so tests inject a fake and nothing else sees SDK types. */
export type TriggerApi = {
  trigger(taskId: string, payload: JobRequest, options: { idempotencyKey: string; externalDeploymentId: string; ttl: number }): Promise<{ id: string }>;
  status(taskId: string): Promise<string>;
  cancel(taskId: string): Promise<void>;
};

export function triggerApi(secretKey: string): TriggerApi {
  const client = new TriggerClient({ accessToken: secretKey });
  return {
    trigger: (taskId, payload, options) => client.tasks.trigger(taskId, payload, options),
    status: async (runId) => String((await client.runs.retrieve(runId)).status),
    cancel: async (runId) => { await client.runs.cancel(runId); },
  };
}

/**
 * One dispatcher over Trigger. `dispatchId` is the provider idempotency key, so a repeated delivery of the same SQL intent maps to the
 * same task; `executionBinding` is the external deployment id (`trigger.dev deploy --external-id`) captured at admission: the run waits for
 * that deployment rather than running on another, and the binding is never re-resolved. The payload carries
 * identities and the deadline only, never prompt or capture content. Any failure is `unavailable`: SQL stays PENDING and repair retries.
 */
export function createJobDispatcher(api: TriggerApi): JobDispatcher {
  return {
    async dispatch(request) {
      const ttl = Math.floor((Date.parse(request.deadlineAt) - Date.now()) / 1000); // a queued task never starts past the run deadline
      if (!Number.isFinite(ttl) || ttl < 1) return { kind: "unavailable" };
      // Trigger silently ignores an id over 128 characters, which would unpin the run: refuse it here instead.
      if (request.executionBinding.length > EXTERNAL_ID_MAX) return { kind: "unavailable" };
      try {
        const handle = await api.trigger(RUN_AI_TASK_ID, { runId: request.runId, dispatchId: request.dispatchId, executionBinding: request.executionBinding, deadlineAt: request.deadlineAt },
          { idempotencyKey: request.dispatchId, externalDeploymentId: request.executionBinding, ttl });
        return handle.id ? { kind: "accepted", taskId: handle.id } : { kind: "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    /** Best effort: `requested` is only an acknowledgement (it never releases a slot); a finished task is `terminal`; anything unclear is `unknown`. */
    async cancel(taskId) {
      try {
        if (FINISHED.has(await api.status(taskId))) return "terminal";
        await api.cancel(taskId);
        return "requested";
      } catch {
        return "unknown";
      }
    },
  };
}
