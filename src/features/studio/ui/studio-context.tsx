"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ErrorDetails } from "@/contracts/http";
import type { CommandResult, GraphCommand } from "@/features/drafts/contracts/commands";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import { acknowledge, follow, refuse } from "./buffers";
import { reconnectCommand, updateCommand } from "./fields";
import { afterDraftRead, requireDraftRevision, type SaveState, type StudioUi } from "./studio-ui";

export type RunOutcome =
  | { ok: true; result: CommandResult }
  | { ok: false; code: string; message: string; uncertain: boolean; details?: ErrorDetails };

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
 * Commands for one open project. Buffers and unresolved receipts live in the shell per-project store, so remounting
 * this provider cannot lose an exact retry. The saved draft also lives in the shell (`adopt` keeps only newer reads).
 */
export function StudioProvider({ projectId, draft, role, archived, narrow, ui, update, adopt, onAccessChanged, onInspect, children }: {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  adopt: (view: DraftView) => void; onAccessChanged: () => void; onInspect: () => void; children: ReactNode;
}) {
  const [localBusy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { pending, save, refreshFailed } = ui;
  // Another instance may still own the request after browser history remounts this keyed provider.
  const busy = localBusy || Boolean(pending?.inFlight);
  const draftId = draft.id;
  const editable = !archived && (role === "OWNER" || role === "EDITOR");

  const reload = useCallback(async () => {
    const result = await apiRead<DraftView>(`/api/projects/${projectId}/drafts/${draftId}`);
    if (sessionEnded(result)) return;
    update((current) => result.ok ? afterDraftRead(current, result.data) : { refreshFailed: true });
    if (result.ok) adopt(result.data);
    else if (result.status === 404) onAccessChanged();
  }, [projectId, draftId, adopt, onAccessChanged, update]);

  const run = useCallback(async (command: GraphCommand, key: string = crypto.randomUUID()): Promise<RunOutcome> => {
    // Read the current shared receipt, not a ref captured by an earlier provider instance.
    const waiting = pending;
    if (busyRef.current || waiting?.inFlight) return { ok: false, code: "BUSY", message: "Another change is still saving.", uncertain: false };
    // One uncertain command stays recoverable across dialogs and view switches. Resolve it before new work.
    // An admitted reader may resolve an already-issued receipt; only the exact pending key/body can cross this guard.
    const exactRetry = waiting?.key === key && JSON.stringify(waiting.command) === JSON.stringify(command);
    if (!editable && !exactRetry) return { ok: false, code: "FORBIDDEN", message: "This draft is read-only.", uncertain: false };
    if (waiting && JSON.stringify(waiting.command) !== JSON.stringify(command)) {
      return { ok: false, code: "UNCONFIRMED_CHANGE", message: "Retry the unconfirmed change before making another.", uncertain: false };
    }
    if (waiting) key = waiting.key;
    const requestDraftId = waiting?.draftId ?? draftId;
    // A global retry can finish after the originating inspector unmounts. Settle only its exact sent request.
    const settle = (outcome: RunOutcome) => update((current) => {
      // A late completion may settle only its own request, never a replacement receipt or another draft.
      if (current.pending?.key !== key || current.pending.draftId !== requestDraftId || JSON.stringify(current.pending.command) !== JSON.stringify(command)) return {};
      let buffers = current.buffers;
      for (const [bufferKey, buffer] of Object.entries(buffers)) {
        if (!buffer.sent || buffer.key !== key || JSON.stringify(updateCommand(buffer.kind, buffer.id, buffer.baseVersion, buffer.sent)) !== JSON.stringify(command)) continue;
        if (outcome.ok) buffers = acknowledge(buffers, bufferKey, outcome.result.versions[buffer.id] ?? buffer.baseVersion);
        else if (!outcome.uncertain) buffers = refuse(buffers, bufferKey, outcome.code === "STALE_ENTITY_VERSION");
      }
      let endpointBuffers = current.endpointBuffers;
      for (const [bufferKey, buffer] of Object.entries(endpointBuffers)) {
        if (!buffer.sent || buffer.key !== key || JSON.stringify(reconnectCommand(buffer.id, buffer.baseVersion, { ...buffer.original, ...buffer.sent })) !== JSON.stringify(command)) continue;
        if (outcome.ok) endpointBuffers = acknowledge(endpointBuffers, bufferKey, outcome.result.documentRevision);
        else if (!outcome.uncertain) endpointBuffers = refuse(endpointBuffers, bufferKey, outcome.code === "STALE_DOCUMENT_REVISION");
      }
      return {
        buffers: outcome.ok ? follow(buffers, outcome.result.versions) : buffers, endpointBuffers,
        pending: !outcome.ok && outcome.uncertain ? { command, key, draftId: requestDraftId, inFlight: false } : null,
        save: outcome.ok ? { state: "saved", message: "" } : { state: "failed", message: outcome.uncertain ? "We could not confirm the last change. Retry it." : outcome.message },
      };
    });
    busyRef.current = true;
    setBusy(true);
    update(() => ({ pending: { command, key, draftId: requestDraftId, inFlight: true }, save: { state: "saving", message: "" } }));
    try {
      const result = await apiMutate<CommandResult>(`/api/projects/${projectId}/drafts/${requestDraftId}/commands`, key, command);
      if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
      if (result.ok) {
        update((current) => ({ acknowledgedRevisions: requireDraftRevision(current.acknowledgedRevisions, result.data) }));
        await reload();
        const outcome = { ok: true as const, result: result.data };
        settle(outcome);
        return outcome;
      }
      if (accessCodes.has(result.code)) onAccessChanged();
      else if (!result.uncertain) await reload(); // a certain refusal (stale, invalid) often means newer saved data
      const outcome = { ok: false as const, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
      settle(outcome);
      return outcome;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [projectId, draftId, reload, onAccessChanged, editable, update, pending]);

  const value = useMemo<Studio>(() => ({ projectId, draft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, run, reload, retry: pending && !pending.inFlight ? () => run(pending.command, pending.key) : null, inspect: onInspect }),
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
