import { schedules } from "@trigger.dev/sdk";
import { jobDispatcher } from "../features/proposals/server/providers.ts";
import { repairRuns } from "../features/proposals/server/repair-runs.ts";

/** Calls the bounded repair service on a one-minute schedule; Task 5 finalizes the maintenance entrypoint around it. */
export const repairRunsTask = schedules.task({
  id: "repair-runs",
  cron: "* * * * *",
  run: async () => {
    const dispatcher = jobDispatcher();
    if (!dispatcher) throw new Error("TRIGGER_SECRET_KEY is required to repair AI dispatch.");
    await repairRuns(dispatcher, { batchSize: 50 });
  },
});
