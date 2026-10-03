import { task } from "@trigger.dev/sdk";
import { runAi } from "../features/proposals/server/run-ai.ts";
import { modelGateway } from "../features/proposals/server/providers.ts";

/** Passes the run identity to the application worker. No prompt, quota, validation or mutation rules live here. */
export const runAiTask = task({
  id: "run-ai",
  // Retry policy lives in trigger.config.ts only. Retries re-enter the service but cannot grant a provider call: only a fresh SQL claim can.
  run: async (payload: { runId: string; dispatchId: string; executionBinding: string; deadlineAt: string }) => {
    await runAi(payload.runId, modelGateway());
  },
});
