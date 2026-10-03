import { schedules } from "@trigger.dev/sdk";
import { runMaintenance } from "../features/proposals/server/maintenance.ts";
import { jobDispatcher } from "../features/proposals/server/providers.ts";

/**
 * The single maintenance schedule: every minute it repairs due AI runs and sweeps expired bodies. Exactly one schedule exists per
 * Trigger environment (declared here, registered by the worker deploy, never by a build hook). A late or doubled tick is harmless
 * because every step is bounded and SQL decides deadlines. The log line carries only the schedule lag and counts, so cadence and
 * jitter can be measured from the Trigger run list without any run content.
 */
export const repairRunsTask = schedules.task({
  id: "repair-runs",
  cron: "* * * * *",
  run: async (payload) => {
    const cleaned = await runMaintenance(jobDispatcher());
    console.info(JSON.stringify({ maintenance: "ok", scheduledAt: payload.timestamp.toISOString(), lagMs: Date.now() - payload.timestamp.getTime(), cleaned }));
  },
});
