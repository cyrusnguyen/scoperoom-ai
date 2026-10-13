import { cron, Inngest } from "inngest";
import { INNGEST_APP_ID, RUN_AI_EVENT } from "../features/proposals/server/adapters/inngest.ts";
import { deliverRun } from "../features/proposals/server/deliver-run.ts";
import { runMaintenance } from "../features/proposals/server/maintenance.ts";
import { jobDispatcher } from "../features/proposals/server/providers.ts";
import type { JobRequest } from "../features/proposals/server/ports.ts";

/** Reads INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY from the worker project's environment. */
export const inngest = new Inngest({ id: INNGEST_APP_ID });

/** Passes the run identity to the application worker. No prompt, quota, validation or mutation rules live here. */
export const runAiFunction = inngest.createFunction(
  { id: "run-ai", retries: 2, triggers: { event: RUN_AI_EVENT } },
  async ({ event, step }) => deliverRun(event.data as JobRequest, step),
);

/** The bounded repair and cleanup sweep. One at a time; no retries, because the next tick is the retry. Returns counts only. */
export const repairFunction = inngest.createFunction(
  { id: "repair-runs", retries: 0, concurrency: 1, triggers: cron("*/5 * * * *") },
  async () => ({ cleaned: await runMaintenance(jobDispatcher()) }),
);
