import type { ApiResult } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { RunPage, RunView } from "../contracts/tasks";
import type { ReconcileResources } from "../../collaboration/ui/project-sync";

type ApiRead = <T>(url: string) => Promise<ApiResult<T>>;
export type ReadState = "uninitialized" | "loading" | "loaded" | "error";
type Destination = "current" | "history";
type Reconciliation = { id: number; status: ProjectStatusView; statusKey: string; fence: () => boolean };
type CurrentParticipant = { id: string; key: string; selection: number; reconciliation: Reconciliation };
export type MissingCurrentTicket = { id: string; isLive: () => boolean };
export type RunResources = { reconcile: ReconcileResources; selectRun: (id: string | null) => void; selectHistory: (id: string | null) => void; retry: () => void; setMissingCurrentHandler: (handler: ((ticket: MissingCurrentTicket) => void) | undefined) => void };
export type RunResourcesOptions = {
  projectId: string; apiRead: ApiRead; adoptPage: (page: RunPage) => void; adoptRun: (run: RunView | null) => void;
  adoptHistoryRun?: (run: RunView | null) => void; adoptReadState?: (destination: "page" | Destination, state: ReadState) => void;
  onMissingCurrent?: (ticket: MissingCurrentTicket) => void;
};

/** One status-driven reader and shared flights, with independent destination adoption under the Sync generation fence. */
export function createRunResources({ projectId, apiRead, adoptPage, adoptRun, adoptHistoryRun, adoptReadState, onMissingCurrent }: RunResourcesOptions): RunResources {
  let loadedAiRevision: number | null = null, wantedAiRevision: number | null = null, nextGeneration = 0, latest: Reconciliation | null = null;
  let pageEvidence: Reconciliation | null = null;
  let missingCurrent: { id: string; key: string; selection: number; reconciliation: Reconciliation } | null = null;
  let missingCurrentHandler = onMissingCurrent;
  const destinations = { current: { id: null as string | null, loaded: "", wanted: "", selection: 0 }, history: { id: null as string | null, loaded: "", wanted: "", selection: 0 } };
  const pageFlights = new Map<() => boolean, { reconciliation: Reconciliation; promise: Promise<void> }>();
  const runFlights = new Map<() => boolean, Map<string, { promise: Promise<void>; origin: Reconciliation; key: string; current?: CurrentParticipant }>>();
  const cache = new Map<string, { key: string; fence: () => boolean; value: RunView }>();
  const pageUrl = `/api/projects/${projectId}/ai-runs`;
  const statusKey = (status: ProjectStatusView) => JSON.stringify([status.aiRevision,status.currentDraftId,status.documentRevision,status.approvedSnapshotId,status.baselineSequence,status.status]);
  const runKey = (status: ProjectStatusView, id: string) => JSON.stringify([id,status.aiRevision,status.currentDraftId,status.documentRevision,status.approvedSnapshotId,status.baselineSequence,status.status]);
  const publish = (destination: Destination, value: RunView | null) => destination === "current" ? adoptRun(value) : adoptHistoryRun?.(value);
  const pageMatches = (reconciliation: Reconciliation) => pageEvidence?.id === reconciliation.id && pageEvidence.statusKey === reconciliation.statusKey && pageEvidence.fence === reconciliation.fence && reconciliation.fence();
  function select(destination: Destination, id: string | null) {
    const target = destinations[destination]; if (target.id === id) return;
    target.id = id; target.loaded = target.wanted = ""; target.selection++; publish(destination,null); adoptReadState?.(destination,"uninitialized");
    for (const cachedId of cache.keys()) if (!Object.values(destinations).some(item => item.id === cachedId)) cache.delete(cachedId);
  }
  function ticketIsLive(missing: NonNullable<typeof missingCurrent>) {
    const current = destinations.current, reconciliation = missing.reconciliation;
    return latest?.id === reconciliation.id && reconciliation.fence() && current.id === missing.id && current.wanted === missing.key && current.selection === missing.selection && pageMatches(reconciliation);
  }
  function publishMissingCurrent() {
    const missing = missingCurrent;
    if (!missing) return;
    if (!ticketIsLive(missing)) { if (latest?.id !== missing.reconciliation.id || !missing.reconciliation.fence() || destinations.current.selection !== missing.selection) missingCurrent = null; return; }
    missingCurrent = null;
    missingCurrentHandler?.({ id: missing.id, isLive: () => ticketIsLive(missing) });
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
  function page(reconciliation: Reconciliation, force = false): Promise<void> {
    if (!force && loadedAiRevision === reconciliation.status.aiRevision) return Promise.resolve();
    const existing = pageFlights.get(reconciliation.fence);
    if (existing) return !force || existing.reconciliation.id === reconciliation.id ? existing.promise : existing.promise.then(() => page(reconciliation,true));
    adoptReadState?.("page","loading");
    const promise = (async () => {
      try {
        const result = await apiRead<RunPage>(pageUrl);
        if (!reconciliation.fence()) return;
        if (result.ok) {
          if (wantedAiRevision === reconciliation.status.aiRevision) { adoptPage(result.data); loadedAiRevision = reconciliation.status.aiRevision; }
          if (latest?.id === reconciliation.id) { pageEvidence = reconciliation; publishMissingCurrent(); }
        }
        if (wantedAiRevision === reconciliation.status.aiRevision) adoptReadState?.("page",result.ok ? "loaded" : "error");
      } catch { if (wantedAiRevision === reconciliation.status.aiRevision && reconciliation.fence()) adoptReadState?.("page","error"); }
    })();
    pageFlights.set(reconciliation.fence,{ reconciliation, promise });
    void promise.finally(() => { if (pageFlights.get(reconciliation.fence)?.promise === promise) pageFlights.delete(reconciliation.fence); }); return promise;
  }
  function recordMissingCurrent(origin: Reconciliation, originKey: string, participant: CurrentParticipant | undefined) {
    if (!participant || !origin.fence() || originKey !== participant.key || origin.statusKey !== participant.reconciliation.statusKey || latest?.id !== participant.reconciliation.id || !participant.reconciliation.fence()) return;
    const current = destinations.current, { id, key, selection, reconciliation } = participant;
    if (current.id !== id || current.wanted !== key || current.selection !== selection) return;
    missingCurrent = { id, key, selection, reconciliation };
    if (pageMatches(reconciliation)) publishMissingCurrent(); else void page(reconciliation,true);
  }
  function detail(destination: Destination, reconciliation: Reconciliation): Promise<void> {
    const target = destinations[destination], id = target.id; if (!id || target.loaded === target.wanted) return Promise.resolve();
    const key = runKey(reconciliation.status,id), retained = cache.get(id);
    if (retained?.key === key && retained.fence()) { adopt(id,key,reconciliation.fence,retained.value); return Promise.resolve(); }
    adoptReadState?.(destination,"loading");
    const flights = runFlights.get(reconciliation.fence) ?? new Map<string,{ promise: Promise<void>; origin: Reconciliation; key: string; current?: CurrentParticipant }>(); runFlights.set(reconciliation.fence,flights);
    const flightKey = JSON.stringify([id,key]);
    const inFlight = flights.get(flightKey); if (inFlight) { if (destination === "current" && (!inFlight.current || inFlight.current.selection === target.selection)) inFlight.current = { id, key, selection: target.selection, reconciliation }; return inFlight.promise; }
    const record: { promise: Promise<void>; origin: Reconciliation; key: string; current?: CurrentParticipant } = { promise: Promise.resolve(), origin: reconciliation, key, ...(destination === "current" ? { current: { id, key, selection: target.selection, reconciliation } } : {}) };
    const flight = (async () => {
      try {
        const result = await apiRead<RunView>(`${pageUrl}/${id}`);
        if (result.ok && reconciliation.fence() && Object.values(destinations).some(item => item.id === id && item.wanted === key)) cache.set(id,{ key, fence: reconciliation.fence, value: result.data });
        if (!result.ok && result.status === 404 && result.code === "NOT_FOUND" && !result.uncertain) recordMissingCurrent(record.origin,record.key,record.current);
        adopt(id,key,reconciliation.fence,result.ok ? result.data : null);
      } catch { adopt(id,key,reconciliation.fence,null); }
    })();
    record.promise = flight;
    flights.set(flightKey,record); void flight.finally(() => { if (flights.get(flightKey)?.promise === flight) flights.delete(flightKey); if (!flights.size && runFlights.get(reconciliation.fence) === flights) runFlights.delete(reconciliation.fence); }); return flight;
  }
  return {
    async reconcile(status,fence) {
      if (!fence()) return;
      const reconciliation = { id: ++nextGeneration, status, statusKey: statusKey(status), fence }; latest = reconciliation; wantedAiRevision = status.aiRevision;
      for (const target of Object.values(destinations)) target.wanted = target.id ? runKey(status,target.id) : "";
      await Promise.all([page(reconciliation),detail("current",reconciliation),detail("history",reconciliation)]);
    },
    selectRun: id => select("current",id), selectHistory: id => select("history",id),
    retry() { loadedAiRevision = null; pageEvidence = null; missingCurrent = null; cache.clear(); for (const target of Object.values(destinations)) target.loaded = ""; },
    setMissingCurrentHandler: handler => { missingCurrentHandler = handler; },
  };
}
