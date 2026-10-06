import type { ApiResult } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { RunPage, RunView } from "../contracts/tasks";
import type { ReconcileResources } from "../../collaboration/ui/project-sync";

type ApiRead = <T>(url: string) => Promise<ApiResult<T>>;
export type ReadState = "uninitialized" | "loading" | "loaded" | "error";
type Destination = "current" | "history";
export type RunResources = { reconcile: ReconcileResources; selectRun: (id: string | null) => void; selectHistory: (id: string | null) => void; retry: () => void };
export type RunResourcesOptions = {
  projectId: string; apiRead: ApiRead; adoptPage: (page: RunPage) => void; adoptRun: (run: RunView | null) => void;
  adoptHistoryRun?: (run: RunView | null) => void; adoptReadState?: (destination: "page" | Destination, state: ReadState) => void;
};

/** One status-driven reader and shared flights, with independent destination adoption under the Sync generation fence. */
export function createRunResources({ projectId, apiRead, adoptPage, adoptRun, adoptHistoryRun, adoptReadState }: RunResourcesOptions): RunResources {
  let loadedAiRevision: number | null = null, wantedAiRevision: number | null = null;
  const destinations = { current: { id: null as string | null, loaded: "", wanted: "" }, history: { id: null as string | null, loaded: "", wanted: "" } };
  const pageFlights = new Map<() => boolean, Promise<void>>();
  const runFlights = new Map<() => boolean, Map<string, Promise<void>>>();
  const cache = new Map<string, { key: string; fence: () => boolean; value: RunView }>();
  const pageUrl = `/api/projects/${projectId}/ai-runs`;
  const runKey = (status: ProjectStatusView, id: string) => JSON.stringify([id,status.aiRevision,status.currentDraftId,status.documentRevision,status.approvedSnapshotId,status.status]);
  const publish = (destination: Destination, value: RunView | null) => destination === "current" ? adoptRun(value) : adoptHistoryRun?.(value);
  function select(destination: Destination, id: string | null) {
    const target = destinations[destination]; if (target.id === id) return;
    target.id = id; target.loaded = target.wanted = ""; publish(destination,null); adoptReadState?.(destination,"uninitialized");
    for (const cachedId of cache.keys()) if (!Object.values(destinations).some(item => item.id === cachedId)) cache.delete(cachedId);
  }
  function adopt(id: string, key: string, fence: () => boolean, value: RunView | null) {
    if (!fence()) return;
    for (const destination of ["current","history"] as const) {
      const target = destinations[destination];
      if (target.id !== id || target.wanted !== key) continue;
      if (value) { publish(destination,value); target.loaded = key; }
      adoptReadState?.(destination,value ? "loaded" : "error");
    }
  }
  function page(status: ProjectStatusView, fence: () => boolean): Promise<void> {
    if (loadedAiRevision === status.aiRevision) return Promise.resolve();
    const inFlight = pageFlights.get(fence); if (inFlight) return inFlight;
    adoptReadState?.("page","loading");
    const flight = (async () => {
      try {
        const result = await apiRead<RunPage>(pageUrl);
        if (wantedAiRevision !== status.aiRevision || !fence()) return;
        if (result.ok) { adoptPage(result.data); loadedAiRevision = status.aiRevision; }
        adoptReadState?.("page",result.ok ? "loaded" : "error");
      } catch { if (wantedAiRevision === status.aiRevision && fence()) adoptReadState?.("page","error"); }
    })();
    pageFlights.set(fence,flight); void flight.finally(() => { if (pageFlights.get(fence) === flight) pageFlights.delete(fence); }); return flight;
  }
  function detail(destination: Destination, status: ProjectStatusView, fence: () => boolean): Promise<void> {
    const target = destinations[destination], id = target.id; if (!id || target.loaded === target.wanted) return Promise.resolve();
    const key = runKey(status,id), retained = cache.get(id);
    if (retained?.key === key && retained.fence()) { adopt(id,key,fence,retained.value); return Promise.resolve(); }
    adoptReadState?.(destination,"loading");
    const flights = runFlights.get(fence) ?? new Map<string,Promise<void>>(); runFlights.set(fence,flights);
    const inFlight = flights.get(id); if (inFlight) return inFlight;
    const flight = (async () => {
      try {
        const result = await apiRead<RunView>(`${pageUrl}/${id}`);
        if (result.ok && fence() && Object.values(destinations).some(item => item.id === id && item.wanted === key)) cache.set(id,{ key, fence, value: result.data });
        adopt(id,key,fence,result.ok ? result.data : null);
      } catch { adopt(id,key,fence,null); }
    })();
    flights.set(id,flight); void flight.finally(() => { if (flights.get(id) === flight) flights.delete(id); if (!flights.size && runFlights.get(fence) === flights) runFlights.delete(fence); }); return flight;
  }
  return {
    async reconcile(status,fence) {
      if (!fence()) return; wantedAiRevision = status.aiRevision;
      for (const target of Object.values(destinations)) target.wanted = target.id ? runKey(status,target.id) : "";
      await Promise.all([page(status,fence),detail("current",status,fence),detail("history",status,fence)]);
    },
    selectRun: id => select("current",id), selectHistory: id => select("history",id),
    retry() { loadedAiRevision = null; cache.clear(); for (const target of Object.values(destinations)) target.loaded = ""; },
  };
}
