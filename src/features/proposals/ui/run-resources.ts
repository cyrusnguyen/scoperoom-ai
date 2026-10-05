import type { ApiResult } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { RunPage, RunView } from "../contracts/tasks";
import type { ReconcileResources } from "../../collaboration/ui/project-sync";

type ApiRead = <T>(url: string) => Promise<ApiResult<T>>;

export type RunResources = {
  reconcile: ReconcileResources;
  selectRun: (runId: string | null) => void;
};

export type RunResourcesOptions = {
  projectId: string;
  apiRead: ApiRead;
  adoptPage: (page: RunPage) => void;
  adoptRun: (run: RunView | null) => void;
};

/**
 * The AI panel's one status-driven resource reader. ProjectSync supplies the timer and generation fence; this only
 * retries cursors that have not been safely adopted yet.
 */
export function createRunResources({ projectId, apiRead, adoptPage, adoptRun }: RunResourcesOptions): RunResources {
  let loadedAiRevision: number | null = null;
  let selectedRunId: string | null = null;
  let loadedRun = "", wantedRun = "";
  let wantedAiRevision: number | null = null;
  const pageFlights = new Map<() => boolean, Promise<void>>();
  const runFlights = new Map<() => boolean, Map<string, Promise<void>>>();

  const pageUrl = `/api/projects/${projectId}/ai-runs`;
  const runKey = (status: ProjectStatusView, runId: string) => JSON.stringify([
    runId, status.aiRevision, status.currentDraftId, status.documentRevision, status.approvedSnapshotId, status.status,
  ]);

  function page(status: ProjectStatusView, fence: () => boolean): Promise<void> {
    if (loadedAiRevision === status.aiRevision) return Promise.resolve();
    const inFlight = pageFlights.get(fence);
    if (inFlight) return inFlight;
    const flight = (async () => {
      try {
        const result = await apiRead<RunPage>(pageUrl);
        if (result.ok && wantedAiRevision === status.aiRevision && fence()) {
          adoptPage(result.data);
          loadedAiRevision = status.aiRevision;
        }
      } catch { /* Keep the cursor unloaded for the next status cycle. */ }
    })();
    pageFlights.set(fence, flight);
    void flight.finally(() => { if (pageFlights.get(fence) === flight) pageFlights.delete(fence); });
    return flight;
  }

  function selected(status: ProjectStatusView, fence: () => boolean): Promise<void> {
    const runId = selectedRunId;
    if (!runId) return Promise.resolve();
    const key = runKey(status, runId);
    if (loadedRun === key) return Promise.resolve();
    const flights = runFlights.get(fence) ?? new Map<string, Promise<void>>();
    runFlights.set(fence, flights);
    const inFlight = flights.get(runId);
    if (inFlight) return inFlight;
    const flight = (async () => {
      try {
        const result = await apiRead<RunView>(`${pageUrl}/${runId}`);
        if (result.ok && selectedRunId === runId && wantedRun === key && fence()) {
          adoptRun(result.data);
          loadedRun = key;
        }
      } catch { /* Keep the resource unloaded for the next status cycle. */ }
    })();
    flights.set(runId, flight);
    void flight.finally(() => {
      if (flights.get(runId) === flight) flights.delete(runId);
      if (!flights.size && runFlights.get(fence) === flights) runFlights.delete(fence);
    });
    return flight;
  }

  return {
    async reconcile(status, fence) {
      if (!fence()) return;
      wantedAiRevision = status.aiRevision;
      wantedRun = selectedRunId ? runKey(status, selectedRunId) : "";
      await Promise.all([page(status, fence), selected(status, fence)]);
    },
    selectRun(runId) {
      if (runId === selectedRunId) return;
      selectedRunId = runId;
      loadedRun = wantedRun = "";
      adoptRun(null);
    },
  };
}
