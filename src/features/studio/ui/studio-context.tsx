"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ErrorDetails } from "@/contracts/http";
import type { CommandResult, GraphCommand } from "@/features/drafts/contracts/commands";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import type { StudioUi } from "./studio-ui";

export type RunOutcome =
  | { ok: true; result: CommandResult }
  | { ok: false; code: string; message: string; uncertain: boolean; details?: ErrorDetails };
export type SaveState = { state: "idle" | "saving" | "saved" | "failed"; message: string };

type Studio = {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; editable: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  /** True while a command is in flight. Mutating controls wait for it: one command at a time per tab. */
  busy: boolean; save: SaveState; refreshFailed: boolean;
  run: (command: GraphCommand, key?: string) => Promise<RunOutcome>;
  reload: () => Promise<void>;
  retry: (() => Promise<RunOutcome>) | null;
  /** Opens the right panel on its Details tab (the Inspect toggle). */
  inspect: () => void;
};

const StudioContext = createContext<Studio | null>(null);

export function useStudio(): Studio {
  const studio = useContext(StudioContext);
  if (!studio) throw new Error("useStudio needs a StudioProvider");
  return studio;
}

/** Codes that mean this person's access or the project's lifecycle changed: the shell re-reads the project. */
const accessCodes = new Set(["FORBIDDEN", "CONFLICT", "NOT_FOUND", "DRAFT_REPLACED"]);

/**
 * Commands and the authoritative draft for one open project. Keyed by project in the shell, so a switch drops its busy
 * state. The saved draft itself lives in the shell (`adopt` keeps only newer reads); typed text lives in `ui.buffers`.
 */
export function StudioProvider({ projectId, draft, role, archived, narrow, ui, update, adopt, onAccessChanged, onInspect, children }: {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  adopt: (view: DraftView) => void; onAccessChanged: () => void; onInspect: () => void; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [save, setSave] = useState<SaveState>({ state: "idle", message: "" });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const busyRef = useRef(false);
  const pendingRef = useRef<{ command: GraphCommand; key: string } | null>(null);
  const [pending, setPending] = useState<{ command: GraphCommand; key: string } | null>(null);
  const draftId = draft.id;
  const editable = !archived && (role === "OWNER" || role === "EDITOR");

  const reload = useCallback(async () => {
    const result = await apiRead<DraftView>(`/api/projects/${projectId}/drafts/${draftId}`);
    if (sessionEnded(result)) return;
    setRefreshFailed(!result.ok);
    if (result.ok) adopt(result.data);
    else if (result.status === 404) onAccessChanged();
  }, [projectId, draftId, adopt, onAccessChanged]);

  const run = useCallback(async (command: GraphCommand, key: string = crypto.randomUUID()): Promise<RunOutcome> => {
    if (busyRef.current) return { ok: false, code: "BUSY", message: "Another change is still saving.", uncertain: false };
    // One uncertain command stays recoverable across dialogs and view switches. Resolve it before new work.
    const waiting = pendingRef.current;
    if (waiting && JSON.stringify(waiting.command) !== JSON.stringify(command)) {
      return { ok: false, code: "UNCONFIRMED_CHANGE", message: "Retry the unconfirmed change before making another.", uncertain: false };
    }
    if (waiting) key = waiting.key;
    busyRef.current = true;
    setBusy(true);
    setSave({ state: "saving", message: "" });
    try {
      const result = await apiMutate<CommandResult>(`/api/projects/${projectId}/drafts/${draftId}/commands`, key, command);
      if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
      if (result.ok) {
        pendingRef.current = null;
        setPending(null);
        await reload();
        setSave({ state: "saved", message: "" });
        return { ok: true, result: result.data };
      }
      pendingRef.current = result.uncertain ? { command, key } : null;
      setPending(pendingRef.current);
      setSave({ state: "failed", message: result.uncertain ? "We couldn’t confirm the last change. Retry it." : result.message });
      if (accessCodes.has(result.code)) onAccessChanged();
      else if (!result.uncertain) await reload(); // a certain refusal (stale, invalid) often means newer saved data
      return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [projectId, draftId, reload, onAccessChanged]);

  const value = useMemo<Studio>(() => ({ projectId, draft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, run, reload, retry: pending ? () => run(pending.command, pending.key) : null, inspect: onInspect }),
    [projectId, draft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, run, reload, pending, onInspect]);
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

/** Dialogs use the provider's single receipt-recovery path, which survives their unmount. */
export function useCommandSubmit() {
  return useStudio().run;
}

/** What to tell someone whose change was not saved. */
export function explain(outcome: Extract<RunOutcome, { ok: false }>): string {
  if (outcome.uncertain) return "We couldn’t confirm this change. Retry sends the same request.";
  if (outcome.code === "STALE_DOCUMENT_REVISION") return "The flow changed while you were working. Review it, then try again.";
  return outcome.message;
}

/** Studio forms: Enter never submits during IME composition, and Ctrl/Cmd+Enter submits from a text area (UI00). */
export function formKeys(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter") return;
  if (event.nativeEvent.isComposing) { event.preventDefault(); return; }
  if ((event.ctrlKey || event.metaKey) && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.currentTarget.requestSubmit(); }
}

/** A single pending request can be recovered even after its originating dialog or List unmounts. */
export function CommandRecovery({ onSettled }: { onSettled?: (outcome: RunOutcome) => void } = {}) {
  const { retry, reload, busy, save, refreshFailed } = useStudio();
  return <>
    {retry && <button type="button" className="button small" disabled={busy} onClick={async () => { const outcome = await retry(); onSettled?.(outcome); }}>Retry last change</button>}
    {refreshFailed && <>
      <span className="status-error" role="alert">{save.state === "saved" ? "Change saved. " : ""}The latest draft could not load.</span>
      <button type="button" className="button small" disabled={busy} onClick={() => void reload()}>Retry read</button>
    </>}
  </>;
}
