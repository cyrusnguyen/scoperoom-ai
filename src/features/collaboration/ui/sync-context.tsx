"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { accountChanged, apiRead, sessionEnded } from "@/client/api";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import { createProjectSync, type AuthorityResult, type Live, type ReconcileReason, type SyncOptions, type SyncState } from "./project-sync";

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
};
const SyncContext = createContext<Sync | null>(null);

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

/**
 * One status controller for the open project, shared by the Studio, the List, the inspector and Details. It is keyed by
 * project in the shell, so a project switch disposes it (its late responses are dropped) and panels or views never add
 * timers or listeners.
 */
export function SyncProvider({ projectId, initial, live, bootstrap, children }: {
  projectId: string; initial: ProjectStatusView; live: () => Live | null; bootstrap: (fence: () => boolean) => Promise<unknown>; children: ReactNode;
}) {
  // What the controller calls back into: the latest shell callbacks and the Studio's registered read.
  const [bridge] = useState(() => ({ live, bootstrap, reader: null as Reader | null }));
  useLayoutEffect(() => { Object.assign(bridge, { live, bootstrap }); });
  const [state, setState] = useState<SyncState>({ status: initial, failures: 0 });
  const [sync] = useState(() => createProjectSync({
    initial,
    random: Math.random,
    setTimer: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
    visibility,
    accountChanged,
    fetchStatus: async () => {
      const result = await apiRead<ProjectStatusView>(`/api/projects/${projectId}/status`);
      sessionEnded(result); // a 401 navigates to sign-in; the controller stops on it
      return result;
    },
    live: () => bridge.live(),
    readDraft: (fence) => bridge.reader?.(fence) ?? Promise.resolve(),
    bootstrap: (fence) => bridge.bootstrap(fence),
    publish: setState,
  }));
  useEffect(() => { sync.start(); return () => sync.dispose(); }, [sync]);
  const setReader = useMemo(() => (read: Reader) => { Object.assign(bridge, { reader: read }); return () => { if (bridge.reader === read) Object.assign(bridge, { reader: null }); }; }, [bridge]);
  const value = useMemo<Sync>(() => ({ ...state, revalidate: sync.revalidate, beforeWrite: sync.beforeWrite, invalidate: sync.invalidate, fence: sync.fence, setReader }), [state, sync, setReader]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
