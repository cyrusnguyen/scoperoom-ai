"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { accountChanged, apiRead, sessionEnded } from "@/client/api";
import { createSupabaseTransport } from "@/client/realtime";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { PresenceState } from "../contracts/messages";
import { createDirectory, type DirectoryMember } from "./participants";
import { createProjectLive, savedViewOf, type ProjectLive } from "./project-live";
import type { PreviewSnapshot } from "./preview-store";
import type { LiveState } from "./realtime-transport";
import { createProjectSync, type AuthorityResult, type Live, type ReconcileReason, type ReconcileResources, type SyncOptions, type SyncState } from "./project-sync";

/** Focus, `online` and a tab becoming visible again revalidate; one listener set per controller. */
const visibility: SyncOptions["visibility"] = {
  hidden: () => document.visibilityState === "hidden",
  listen: (on) => {
    const focus = () => on("focus"), blur = () => on("blur"), online = () => on("reconnect"), shown = () => on(document.visibilityState === "visible" ? "focus" : "hidden");
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", shown);
    };
  },
};

type Reader = SyncOptions["readDraft"];
type Sync = {
  /** The latest status: the bootstrap's until a poll or a revalidation replaces it. */
  status: ProjectStatusView;
  /** Consecutive failed status reads; 2 or more means the poll is backed off at its 30 s cap. */
  failures: number;
  revalidate: (reason: ReconcileReason) => Promise<AuthorityResult>;
  beforeWrite: () => Promise<AuthorityResult>;
  /** Marks authority unproven (an API failure, a draft change): the next write waits for a fresh status read. */
  invalidate: () => void;
  /** True while nothing has replaced this project or its draft: check right before adopting a late response. */
  fence: (at?: number) => () => boolean;
  setReader: (read: Reader) => () => void;
  setAiReader: (read: ReconcileResources) => () => void;
  setActiveJobVisible: (on: boolean) => void;
  /** The Studio reports each adopted saved draft, so previews are checked against saved data. */
  setSavedDraft: (draft: DraftView) => void;
  /** Realtime: `degraded` shows "Live updates delayed" and never blocks saving. */
  liveState: LiveState;
  /** Other sessions of this project and draft, from Presence; advisory names and places, never authority. */
  roster: PresenceState[];
  /** The authorized members list (names and roles for the roster); null until first read. Peers' own claims never supply a name. */
  directory: DirectoryMember[] | null;
  /** Remote cursors and drag ghosts: `snapshot()` is referentially stable while unchanged; read it when notified and again at `nextExpiry()` (expiry only shows on a read). */
  previews: Pick<ProjectLive, "snapshot" | "subscribe" | "nextExpiry">;
  sendCursor: ProjectLive["sendCursor"];
  sendDrag: ProjectLive["sendDrag"];
  endDrag: ProjectLive["endDrag"];
  setPresence: ProjectLive["setPresence"];
};
export type { PreviewSnapshot };
const SyncContext = createContext<Sync | null>(null);
/** One transport for the app: it holds no connection until a project asks for one. */
const transport = createSupabaseTransport();

export function useSync(): Sync {
  const sync = useContext(SyncContext);
  if (!sync) throw new Error("useSync needs a SyncProvider");
  return sync;
}

/** The Studio registers its gated D read here, so polling adopts through the same gate as every other read. */
export function useSyncReader(read: Reader) {
  const setReader = useContext(SyncContext)?.setReader;
  useEffect(() => setReader?.(read), [setReader, read]);
}

/** The mounted AI panel contributes one resource reader to the project's existing status controller. */
export function useAiSyncReader(read: ReconcileResources) {
  const setAiReader = useContext(SyncContext)?.setAiReader;
  useEffect(() => setAiReader?.(read), [setAiReader, read]);
}

/** The Studio reports the saved draft it has adopted (once per adoption), so remote previews are validated against it. */
export function useSyncSavedDraft(draft: DraftView) {
  const setSavedDraft = useContext(SyncContext)?.setSavedDraft;
  useEffect(() => setSavedDraft?.(draft), [setSavedDraft, draft]);
}

/**
 * One status controller for the open project, shared by the Studio, the List, the inspector and Details. It is keyed by
 * project in the shell, so a project switch disposes it (its late responses are dropped) and panels or views never add
 * timers or listeners. It also owns the Realtime connection (two channels), the preview store and the roster: a status epoch or
 * draft change replaces the connection, and unmount disposes it.
 */
export function SyncProvider({ projectId, initial, live, bootstrap, children }: {
  projectId: string; initial: ProjectStatusView; live: () => Live | null; bootstrap: (fence: () => boolean) => Promise<unknown>; children: ReactNode;
}) {
  // What the controller calls back into: the latest shell callbacks and the Studio's registered read.
  const [bridge] = useState(() => ({ live, bootstrap, reader: null as Reader | null, aiReader: null as ReconcileResources | null }));
  useLayoutEffect(() => { Object.assign(bridge, { live, bootstrap }); });
  const [state, setState] = useState<SyncState>({ status: initial, failures: 0 });
  const [sync] = useState(() => createProjectSync({
    initial,
    random: Math.random,
    setTimer: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
    visibility,
    accountChanged,
    sessionEnded: () => { sessionEnded({ ok: false, code: "UNAUTHENTICATED", message: "Sign in to continue.", status: 401, uncertain: false }); },
    fetchStatus: () => apiRead<ProjectStatusView>(`/api/projects/${projectId}/status`),
    live: () => bridge.live(),
    readDraft: (fence) => bridge.reader?.(fence) ?? Promise.resolve(),
    bootstrap: (fence) => bridge.bootstrap(fence),
    publish: setState,
    reconcileResources: (status, fence) => bridge.aiReader?.(status, fence) ?? Promise.resolve(),
  }));
  const [realtime] = useState(() => createProjectLive({
    transport, sessionId: crypto.randomUUID(), now: Date.now,
    setTimer: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
    revalidate: (reason) => { void sync.revalidate(reason); },
    degraded: (on) => sync.setDegraded(on),
  }));
  useEffect(() => { sync.start(); return () => sync.dispose(); }, [sync]);
  const { realtimeEpoch, currentDraftId, viewerId, role, status: lifecycle } = state.status;
  const canSend = lifecycle === "ACTIVE" && (role === "OWNER" || role === "EDITOR");
  useEffect(() => { realtime.setScope({ projectId, epoch: realtimeEpoch, draftId: currentDraftId, profileId: viewerId, canSend }); }, [realtime, projectId, realtimeEpoch, currentDraftId, viewerId, canSend]);
  useEffect(() => () => realtime.setScope(null), [realtime]); // StrictMode's simulated unmount disposes the connection; the effect above joins again
  const liveState = useSyncExternalStore(realtime.subscribe, realtime.state, realtime.state);
  const roster = useSyncExternalStore(realtime.subscribe, realtime.roster, realtime.roster);
  const [directory, setDirectory] = useState<DirectoryMember[] | null>(null);
  const directoryLoader = useMemo(() => createDirectory({
    read: async () => {
      const result = await apiRead<{ members: DirectoryMember[] }>(`/api/projects/${projectId}/members`);
      return sessionEnded(result) || !result.ok ? null : result.data.members;
    },
    fence: sync.fence, publish: setDirectory,
  }), [projectId, sync]);
  // Once, and again when membership changes; a failed read is tried again on the next roster or status change (a status poll that fails or moves publishes a new state).
  useEffect(() => { void directoryLoader.update(state.status.membershipVersion); }, [directoryLoader, state, roster]);
  const setSavedDraft = useCallback((draft: DraftView) => realtime.setSavedView(savedViewOf(draft)), [realtime]);
  // A bootstrap installed outside the controller (Restore, Details, Retry) can be newer than its last read: prove authority again before the next write.
  const installed = useRef(initial);
  useEffect(() => { if (installed.current !== initial) { installed.current = initial; sync.invalidate(); } }, [initial, sync]);
  const setReader = useMemo(() => (read: Reader) => { Object.assign(bridge, { reader: read }); return () => { if (bridge.reader === read) Object.assign(bridge, { reader: null }); }; }, [bridge]);
  const setAiReader = useMemo(() => (read: ReconcileResources) => { Object.assign(bridge, { aiReader: read }); return () => { if (bridge.aiReader === read) Object.assign(bridge, { aiReader: null }); }; }, [bridge]);
  const previews = useMemo(() => ({ snapshot: realtime.snapshot, subscribe: realtime.subscribe, nextExpiry: realtime.nextExpiry }), [realtime]);
  const value = useMemo<Sync>(() => ({
    ...state, revalidate: sync.revalidate, beforeWrite: sync.beforeWrite, invalidate: sync.invalidate, fence: sync.fence, setReader, setAiReader, setActiveJobVisible: sync.setActiveJobVisible, setSavedDraft,
    liveState, roster, directory, previews, sendCursor: realtime.sendCursor, sendDrag: realtime.sendDrag, endDrag: realtime.endDrag, setPresence: realtime.setPresence,
  }), [state, sync, setReader, setAiReader, setSavedDraft, liveState, roster, directory, previews, realtime]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
