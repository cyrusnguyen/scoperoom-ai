"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ErrorDetails } from "@/contracts/http";
import type { CommandResult, GraphCommand } from "@/features/drafts/contracts/commands";
import type { ArrangementPreview, ArrangementRequest, PositionCommand, PositionResult } from "@/features/drafts/contracts/positions";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import { acknowledge, follow, refuse } from "./buffers";
import { reconnectCommand, updateCommand } from "./fields";
import {
  afterDraftRead, AUTOSAVE_MS, canUndo, forgetMoves, moveChunks, recordDrop, requireDraftRevision, settleMoves, undoDrop,
  type Attempt, type SaveState, type StudioUi, type UnsavedMoves,
} from "./studio-ui";

export type { Attempt } from "./studio-ui";
export type Outcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; message: string; uncertain: boolean; details?: ErrorDetails };
export type RunOutcome = Outcome<CommandResult>;
type Target = { nodeId: string; x: number; y: number };

type Studio = {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; editable: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  /** True while a command or position save is in flight. Mutating controls wait for it: one request at a time per tab. */
  busy: boolean;
  /** Content saves ("All changes saved") and position saves ("Positions saved") are reported separately. */
  save: SaveState; placement: SaveState; refreshFailed: boolean;
  run: (command: GraphCommand, key?: string) => Promise<RunOutcome>;
  place: (command: PositionCommand, key?: string) => Promise<Outcome<PositionResult>>;
  preview: (request: ArrangementRequest) => Promise<Outcome<ArrangementPreview>>;
  reload: () => Promise<void>;
  retry: (() => Promise<RunOutcome>) | null;
  /** The person's position save being sent, or unresolved (unconfirmed or refused as a conflict), shown over the saved layout. */
  attempt: Attempt | null;
  /** The flow whose last own move can still be undone, if any: the latest local drop while moves are unsaved. */
  undoFlowId: string | null;
  /** True while dropped steps wait to be saved (Save, autosave, or before Arrange and flow/project switches). */
  unsaved: boolean;
  /** Keeps dropped steps as unsaved moves; `save` sends them at once (the position form's Move). */
  moveSteps: (flowId: string, targets: Target[], save?: boolean) => Promise<void>;
  /** Sends every unsaved move. True once all are saved (or there were none); false if any stayed unsaved. */
  savePositions: () => Promise<boolean>;
  /** The canvas reports a pointer drag in progress, so autosave never sends mid-drag. */
  dragActive: (active: boolean) => void;
  retryPlacement: () => Promise<void>; applyMyPlacement: () => Promise<void>; keepSavedPositions: () => void; undoMove: () => Promise<void>;
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
const idle: SaveState = { state: "idle", message: "" };
const busyOutcome = { ok: false as const, code: "BUSY", message: "Another change is still saving.", uncertain: false };

/**
 * Commands and position saves for one open project. Buffers, unresolved receipts, the in-flight position key and the
 * unresolved placement live in the shell per-project store, so remounting this provider cannot lose an exact retry or
 * start a second request. The saved draft also lives in the shell (`adopt` keeps only newer reads).
 */
export function StudioProvider({ projectId, draft, role, archived, narrow, ui, update, adopt, onAccessChanged, onInspect, saveRef, children }: {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  adopt: (view: DraftView) => void; onAccessChanged: () => void; onInspect: () => void;
  /** Lets the shell save moved steps before a project switch. */
  saveRef?: RefObject<(() => Promise<boolean>) | null>; children: ReactNode;
}) {
  const [localBusy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { pending, save, refreshFailed, placement, placing, attempt, lastMove, unsavedMoves, drops } = ui;
  const unsaved = Object.keys(unsavedMoves).length > 0;
  // Another instance may still own the request after browser history remounts this keyed provider.
  const busy = localBusy || Boolean(pending?.inFlight) || Boolean(placing);
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
    // Commands and position saves share one request at a time, including one still owned by an earlier provider.
    if (busyRef.current || waiting?.inFlight || placing) return busyOutcome;
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
      // Only this command's effective document change may advance an unsent endpoint choice. A no-op receipt can
      // report a revision written by another tab; existing conflicts still need explicit review.
      const changed = outcome.ok && (outcome.result.createdIds.length > 0 || outcome.result.retiredIds.length > 0 || Object.keys(outcome.result.versions).length > 0);
      if (changed) endpointBuffers = follow(endpointBuffers, Object.fromEntries(Object.values(endpointBuffers)
        .map((buffer) => [buffer.id, outcome.result.documentRevision])));
      return {
        // A deleted step has no position left to save: its unsaved move and local undo go with it.
        ...(outcome.ok && outcome.result.retiredIds.length ? forgetMoves(current, outcome.result.retiredIds) : {}),
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
  }, [projectId, draftId, reload, onAccessChanged, editable, update, pending, placing]);

  /**
   * Sends one position save on the command path's one-request-at-a-time lock, then re-reads the saved draft whatever
   * the answer. Returns null while another request is in flight. `next` is stored with the in-flight key, so a remounted
   * provider still shows and locks that placement.
   */
  const send = useCallback(async (command: PositionCommand, key: string, requestDraftId: string, next?: Attempt): Promise<Outcome<PositionResult> | null> => {
    if (busyRef.current || pending?.inFlight || placing) return null;
    // As with commands, only the exact unresolved placement may be retried after access narrows.
    if (!editable && attempt?.key !== key) return { ok: false, code: "FORBIDDEN", message: "This draft is read-only.", uncertain: false };
    busyRef.current = true;
    setBusy(true);
    update(() => ({ placing: key, placement: { state: "saving", message: "" }, ...(next ? { attempt: { ...next, state: "pending" as const } } : {}) }));
    try {
      const result = await apiMutate<PositionResult>(`/api/projects/${projectId}/drafts/${requestDraftId}/positions`, key, command);
      if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
      if (result.ok) {
        // A position receipt proves the layout revision; the document revision floor stays as it was.
        update((current) => ({ acknowledgedRevisions: requireDraftRevision(current.acknowledgedRevisions, { draftId: result.data.draftId, documentRevision: 0, layoutRevision: result.data.layoutRevision }) }));
        await reload();
        update(() => ({ placement: { state: "saved", message: "" } }));
        return { ok: true, result: result.data };
      }
      update(() => ({ placement: { state: "failed", message: result.uncertain ? "We couldn’t confirm the new position." : result.message } }));
      if (accessCodes.has(result.code)) onAccessChanged();
      else if (!result.uncertain) await reload(); // a certain refusal (conflict, stale) usually means newer saved data
      return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
    } finally {
      busyRef.current = false;
      setBusy(false);
      update((current) => (current.placing === key ? { placing: null } : {}));
    }
  }, [projectId, reload, onAccessChanged, editable, update, pending, placing, attempt]);

  const place = useCallback(async (command: PositionCommand, key: string = crypto.randomUUID()) => (await send(command, key, draftId)) ?? busyOutcome, [send, draftId]);

  /** A nonmutating arrangement preview: no key, no lock, and a certain refusal re-reads the draft it was stale against. */
  const preview = useCallback(async (request: ArrangementRequest): Promise<Outcome<ArrangementPreview>> => {
    const result = await apiMutate<ArrangementPreview>(`/api/projects/${projectId}/drafts/${draftId}/arrangement-preview`, null, request);
    if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
    if (result.ok) return { ok: true, result: result.data };
    if (accessCodes.has(result.code)) onAccessChanged();
    else if (!result.uncertain) await reload();
    return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
  }, [projectId, draftId, reload, onAccessChanged]);

  /**
   * Saves one MOVE_NODES and settles only its own attempt: saved (its steps leave the unsaved moves), unconfirmed (same
   * key to retry) or refused as a conflict (the placement stays until the person chooses). Null while another request runs.
   */
  const attemptMove = useCallback(async (next: Attempt): Promise<Outcome<PositionResult> | null> => {
    const outcome = await send(next.command, next.key, next.draftId, next);
    if (!outcome) return null;
    update((current) => {
      if (current.attempt?.key !== next.key) return {};
      if (outcome.ok) {
        if (next.undo) return { attempt: null, lastMove: null };
        const moved = Object.entries(outcome.result.positions).filter(([nodeId]) => next.before[nodeId]);
        return {
          ...settleMoves(current, next.command.items, outcome.result.positions), attempt: null,
          lastMove: moved.length ? { flowId: next.flowId, items: moved.map(([nodeId, saved]) => ({ nodeId, ...next.before[nodeId]!, version: saved.version })) } : current.lastMove,
        };
      }
      if (outcome.uncertain) return { attempt: { ...next, state: "uncertain" } };
      if (outcome.code === "POSITION_CONFLICT" && !next.undo) return { attempt: { ...next, state: "conflict" } };
      // Any other certain refusal shows the saved layout again, as a refused drop always has.
      if (!next.undo) return { ...forgetMoves(current, next.command.items.map((item) => item.nodeId)), attempt: null };
      return { attempt: null, lastMove: null, placement: { state: "failed", message: outcome.code === "POSITION_CONFLICT" ? "A step moved since your last move, so it can’t be undone." : outcome.message } };
    });
    return outcome;
  }, [send, update]);

  /** A new move from the saved positions on screen; expected versions come from that saved layout unless given. */
  const move = useCallback(async (flowId: string, targets: Target[], expected?: Record<string, number>, undo = false) => {
    const saved = draft.layout.positions;
    const live = targets.filter((target) => saved[target.nodeId]);
    if (!live.length) return;
    await attemptMove({
      draftId, flowId, key: crypto.randomUUID(), undo, state: "pending",
      command: { mode: "MOVE_NODES", flowId, items: live.map(({ nodeId, x, y }) => ({ nodeId, expectedPositionVersion: expected?.[nodeId] ?? saved[nodeId]!.version, x, y })) },
      before: Object.fromEntries(live.map(({ nodeId }) => [nodeId, { x: saved[nodeId]!.x, y: saved[nodeId]!.y }])),
    });
  }, [draft, draftId, attemptMove]);

  /**
   * Sends unsaved moves: one flow at a time, chunks of at most 20, one request after another on the shared path. The first
   * chunk that is not acknowledged stops the flush and keeps every unsent move; "Positions saved" shows only once none
   * remain. Steps no longer in the document are dropped first.
   */
  // ponytail: sequential ≤20-step MOVE_NODES chunks through the single attempt slot; a multi-chunk flush is not atomic and
  // Undo covers only its last chunk. To be replaced by one batch save (POST D/changes: queued commands and moves, one key).
  const flush = useCallback(async (moves: UnsavedMoves): Promise<boolean> => {
    const gone = Object.keys(moves).filter((nodeId) => !draft.document.nodes[nodeId] || !draft.layout.positions[nodeId]);
    if (gone.length) update((current) => forgetMoves(current, gone));
    const chunks = moveChunks(moves, draft.layout, draft.document.nodes);
    if (!chunks.length) return true;
    // An unconfirmed or refused save is resolved first (Retry, Apply my placement or Keep saved positions).
    if (attempt) return false;
    const saved = draft.layout.positions;
    for (const command of chunks) {
      const outcome = await attemptMove({
        draftId, flowId: command.flowId, key: crypto.randomUUID(), undo: false, state: "pending", command,
        before: Object.fromEntries(command.items.map(({ nodeId }) => [nodeId, { x: saved[nodeId]!.x, y: saved[nodeId]!.y }])),
      });
      if (!outcome?.ok) return false;
    }
    return true;
  }, [draft, draftId, attempt, attemptMove, update]);
  const savePositions = useCallback(() => flush(unsavedMoves), [flush, unsavedMoves]);

  // ponytail: one unresolved placement at a time (a single store slot), so no step is dragged again until the person
  // retries, reapplies or keeps the saved positions; per-step attempts would need a keyed map of attempts.
  const moveSteps = useCallback(async (flowId: string, targets: Target[], saveNow = false) => {
    if (attempt) return;
    // A new drop replaces an earlier failure message with "Unsaved positions".
    update((current) => ({ ...recordDrop(current, flowId, targets, draft.layout), ...(current.placement.state === "failed" ? { placement: idle } : {}) }));
    if (saveNow) await flush(recordDrop(ui, flowId, targets, draft.layout).unsavedMoves);
  }, [attempt, update, draft, flush, ui]);
  const retryPlacement = useCallback(async () => { if (attempt?.state === "uncertain") await attemptMove(attempt); }, [attempt, attemptMove]);
  // Explicit reapply after a conflict: the same placement against the newly read versions, as a new operation.
  const applyMyPlacement = useCallback(async () => {
    if (attempt?.state === "conflict") await move(attempt.flowId, attempt.command.items.map(({ nodeId, x, y }) => ({ nodeId, x, y })));
  }, [attempt, move]);
  // Dropping an unconfirmed or refused placement shows the saved layout again, re-read in case the request did commit.
  const keepSavedPositions = useCallback(() => {
    update((current) => (current.attempt && current.attempt.state !== "pending"
      ? { ...forgetMoves(current, current.attempt.command.items.map((item) => item.nodeId)), attempt: null, placement: idle } : {}));
    void reload();
  }, [update, reload]);
  // With unsaved moves, Undo reverts the latest local drop (no request). Otherwise it is a new versioned save back to the
  // "before" positions, guarded by the versions the last acknowledged move saved.
  const undoMove = useCallback(async () => {
    if (attempt || busyRef.current) return;
    if (unsaved) { update((current) => undoDrop(current)); return; }
    if (!lastMove) return;
    await move(lastMove.flowId, lastMove.items.map(({ nodeId, x, y }) => ({ nodeId, x, y })), Object.fromEntries(lastMove.items.map((item) => [item.nodeId, item.version])), true);
  }, [lastMove, attempt, unsaved, update, move]);

  // Autosave: one timer per open project (this provider is keyed by project, so unmount clears it). It runs only while
  // moves are unsaved, nothing is in flight and no save awaits the person's choice; a tick during a drag is skipped.
  // Hidden tabs keep it: the browser throttles the timer, and saving there still narrows what a closed tab could lose.
  const dragging = useRef(false);
  const dragActive = useCallback((active: boolean) => { dragging.current = active; }, []);
  const autosave = useRef(savePositions);
  useEffect(() => {
    autosave.current = savePositions;
    if (!saveRef) return;
    saveRef.current = savePositions;
    return () => { if (saveRef.current === savePositions) saveRef.current = null; };
  }, [savePositions, saveRef]);
  useEffect(() => {
    if (!editable || !unsaved || busy || attempt) return;
    const timer = window.setInterval(() => { if (!dragging.current) void autosave.current(); }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [editable, unsaved, busy, attempt]);

  const undoFlowId = unsaved ? drops.at(-1)?.flowId ?? null : lastMove && canUndo(lastMove, draft.layout) ? lastMove.flowId : null;
  const value = useMemo<Studio>(() => ({
    projectId, draft, role, archived, editable, narrow, ui, update, busy, save, placement, refreshFailed, run, place, preview, reload,
    retry: pending && !pending.inFlight ? () => run(pending.command, pending.key) : null,
    attempt, undoFlowId, unsaved, moveSteps, savePositions, dragActive, retryPlacement, applyMyPlacement, keepSavedPositions, undoMove, inspect: onInspect,
  }), [projectId, draft, role, archived, editable, narrow, ui, update, busy, save, placement, refreshFailed, run, place, preview, reload, pending,
    attempt, undoFlowId, unsaved, moveSteps, savePositions, dragActive, retryPlacement, applyMyPlacement, keepSavedPositions, undoMove, onInspect]);
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
