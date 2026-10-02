"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ErrorDetails } from "@/contracts/http";
import type { ChangesResult } from "@/features/drafts/contracts/changes";
import type { GraphCommand } from "@/features/drafts/contracts/commands";
import type { ArrangementPreview, ArrangeFlow, ArrangementRequest, PositionResult } from "@/features/drafts/contracts/positions";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { ImportApplyResult } from "@/features/exchange/contracts/import";
import { importBlocker, importStorageError, persistImport } from "@/features/exchange/ui/import-recovery";
import { GraphError } from "@/features/drafts/domain/graph";
import { projectErrors } from "@/features/projects/contracts/errors";
import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import { claimOf } from "@/features/collaboration/ui/participants";
import { useSync, useSyncReader, useSyncSavedDraft } from "@/features/collaboration/ui/sync-context";
import { follow } from "./buffers";
import { currentFlow } from "./graph-view";
import {
  acknowledged, addDrop, discardOutbox, enqueue, keepTheirs as keepTheirsChange, optimistic, pendingCount, rebase, redo as redoChange, replay, startSave, undo as undoChange,
  wireBody, withEntries, type ConflictTarget, type Outbox, type Placement, type Sending,
} from "./outbox";
import { advanceOnRead, afterDraftRead, AUTOSAVE_MS, clearedRedo, covers, frozenBehind, requireDraftRevision, stranded, type SaveState, type StudioUi } from "./studio-ui";

export type Outcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; message: string; uncertain: boolean; details?: ErrorDetails };
/** A change applied locally and queued: the ids it created (final: the save proposes them) and the versions it set. */
export type Queued = { createdIds: string[]; versions: Record<string, number>; retiredIds: string[]; documentRevision: number };
export type RunOutcome = Outcome<Queued>;

type Studio = {
  projectId: string;
  /** What every view shows: the saved draft with the unsaved changes applied (readers see the saved draft). */
  draft: DraftView;
  /** The last draft read from the server. */
  savedDraft: DraftView;
  role: ProjectAccessRole; archived: boolean; editable: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  /** True while a save or arrangement request is in flight (one request at a time per tab). Editing continues. */
  busy: boolean;
  save: SaveState; refreshFailed: boolean;
  /** Consecutive saved reads that failed or fell below the acknowledged floor (reset by a covering read). */
  readFailures: number;
  /** An adopted saved read waits behind the shown (frozen) draft because unsaved or unconfirmed changes would change. */
  frozen: boolean;
  /** A saved read was adopted and cleared a nonempty redo history; one message until dismissed. */
  redoCleared: boolean; dismissRedoCleared: () => void;
  /** Applies a command to the shown draft and queues it for the next save; a refusal is the server's own. */
  run: (command: GraphCommand) => Promise<RunOutcome>;
  /** Queues dropped steps. `save` saves every unsaved change at once (the position form's Move); `joined` makes the
   * drop part of the change before it for undo (a new shape's drop point). */
  moveSteps: (flowId: string, targets: Placement[], options?: { save?: boolean; joined?: boolean }) => Promise<void>;
  /** Sends every unsaved change (retrying an unconfirmed batch with its key). True once none is left unsaved. */
  saveChanges: () => Promise<boolean>;
  /** Any unsaved change, sent or not. */
  unsaved: boolean;
  applyAgain: () => Promise<void>; discardChanges: () => void; dismissDropped: () => void;
  /** After a refused save: drop one of my conflicting changes and keep what someone else saved. */
  keepTheirs: (target: ConflictTarget) => void;
  /** Unsaved changes that no longer apply to the shown draft: listed, never silently dropped (a save leaves them out). */
  skipped: string[];
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  place: (command: ArrangeFlow, key?: string) => Promise<Outcome<PositionResult>>;
  preview: (request: ArrangementRequest) => Promise<Outcome<ArrangementPreview>>;
  importFlow: (previewId: string, input: { draftId: string; previewHash: string }, key: string) => Promise<Outcome<ImportApplyResult>>;
  reload: (fence?: () => boolean) => Promise<DraftView | null>;
  /** The canvas reports a pointer drag in progress, so autosave never sends mid-drag. */
  dragActive: (active: boolean) => void;
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
/** A save refused because someone else saved first: the person reviews and applies their changes again. */
export const staleCodes = new Set(["STALE_DOCUMENT_REVISION", "STALE_ENTITY_VERSION", "STALE_LAYOUT_REVISION", "POSITION_CONFLICT", "DEPENDENCY_CONFLICT"]);
type Admission = { blocked: { code: string; message: string }; stillCurrent?: undefined } | { blocked: null; stillCurrent: () => boolean };
const busyOutcome = { ok: false as const, code: "BUSY", message: "Another change is still saving.", uncertain: false };
const readOnly = { ok: false as const, code: "FORBIDDEN", message: "This draft is read-only.", uncertain: false };

/**
 * Local-first editing for one open project (Task 14b). Every change is applied to the shown draft at once and waits in
 * the outbox (the shell per-project store, so it survives remounts but not reloads) until Save, the 10-second autosave,
 * or a save-first action sends it as one POST D/changes. Nothing is reported saved before its acknowledgement; an
 * unconfirmed batch is retried only with its key and body; a refused one waits for the person. The saved draft lives in
 * the shell too (`adopt` keeps only newer reads).
 */
export function StudioProvider({ projectId, draft: savedDraft, role, archived, narrow, ui, update, adopt, onAccessChanged, onInspect, saveRef, children }: {
  projectId: string; draft: DraftView; role: ProjectAccessRole; archived: boolean; narrow: boolean;
  ui: StudioUi; update: (change: (ui: StudioUi) => Partial<StudioUi>) => void;
  adopt: (view: DraftView) => boolean; onAccessChanged: () => void; onInspect: () => void;
  /** Lets the shell save unsaved changes before a project switch. */
  saveRef?: RefObject<(() => Promise<boolean>) | null>; children: ReactNode;
}) {
  const { outbox, request, save, refreshFailed } = ui;
  const { beforeWrite, fence, invalidate, setPresence } = useSync();
  // Another instance may still own the request after browser history remounts this keyed provider.
  const busy = Boolean(request);
  const draftId = savedDraft.id;
  // Unsent work on a replaced draft is never retargeted: the draft is read-only and the work waits in copy/discard recovery.
  const editable = !archived && (role === "OWNER" || role === "EDITOR") && !stranded(outbox, draftId);

  // Synchronous copies, so actions in one event (a shape's step and its drop point) and async saves see every change
  // already made; each render catches them up with the store, which also changes from outside (discard, remounts).
  const latest = useRef(outbox);
  const saved = useRef(savedDraft);
  const inFlight = useRef(request);
  // The acknowledged floor of this draft, kept like the copies above so a change made in the same event sees it.
  const floorRef = useRef(ui.acknowledgedRevisions[savedDraft.id]);
  const floor = ui.acknowledgedRevisions[draftId];
  const mounted = useRef(true);
  const uiRef = useRef(ui);
  const dragging = useRef(false);
  useLayoutEffect(() => { uiRef.current = ui; }, [ui]);
  useLayoutEffect(() => { latest.current = outbox; }, [outbox]);
  useLayoutEffect(() => { saved.current = savedDraft; }, [savedDraft]);
  useLayoutEffect(() => { inFlight.current = request; }, [request]);
  useLayoutEffect(() => { floorRef.current = floor; }, [floor]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A different draft is another authority to establish before the next write.
  const shownDraft = useRef(draftId);
  useEffect(() => { if (shownDraft.current !== draftId) { shownDraft.current = draftId; invalidate(); } }, [draftId, invalidate]);
  const [readFailures, setReadFailures] = useState(0);
  const [redoCleared, setRedoCleared] = useState(false);
  if (!refreshFailed && readFailures) setReadFailures(0); // any covering read, from any path, starts the count over

  /** One pure outbox change, applied to the synchronous copy now and to the store in order. */
  const change = useCallback((next: (current: Outbox) => Outbox, also?: (current: StudioUi) => Partial<StudioUi>) => {
    latest.current = next(latest.current);
    update((current) => ({ outbox: next(current.outbox), ...(also ? also(current) : {}) }));
  }, [update]);

  // Every adopted saved read (shell bootstrap or adoption, and `reload`) lands here as a new `savedDraft`. The frozen base
  // follows it through `advanceOnRead` (never while a save is pending; only once the read covers the acknowledged floor).
  // It runs again when a save resolves (`pending`) and whenever the active entries change (Keep theirs, undo, redo, a new
  // edit): the base must follow the adopted read as soon as no request would change, or the shown draft and the frozen
  // notice (derived from the same test) disagree, and an undo to empty must not let a redo switch back to an old base.
  // The store's updater advances the store's own current outbox, because the shell also writes it outside `change`
  // (Discard) between this render and the effect.
  const pending = Boolean(outbox.sending), { entries } = outbox;
  useEffect(() => {
    const before = latest.current, next = advanceOnRead(before, savedDraft, floor);
    if (next === before) return;
    // Only this call clears redo on a read (the person's own undo, redo and edits do not go through here), and an
    // unchanged re-read leaves an already-empty redo alone: one message per clearing.
    if (clearedRedo(before, next)) setRedoCleared(true);
    change((current) => (current === before ? next : advanceOnRead(current, savedDraft, floor)));
  }, [savedDraft, floor, pending, entries, change]);
  const frozen = useMemo(() => frozenBehind(outbox, savedDraft, floor), [outbox, savedDraft, floor]);

  // `fence` (polling only) drops a response the sync controller has since replaced, right before anything is adopted.
  const reload = useCallback(async (stillCurrent?: () => boolean): Promise<DraftView | null> => {
    const current = stillCurrent ?? fence();
    const result = await apiRead<DraftView>(`/api/projects/${projectId}/drafts/${draftId}`);
    if (!mounted.current || !current()) return null;
    if (sessionEnded(result)) return null;
    if (!result.ok) {
      if (result.uncertain) invalidate();
      update(() => ({ refreshFailed: true }));
      setReadFailures((count) => count + 1);
      if (result.status === 404) onAccessChanged();
      return null;
    }
    // One gate (the shell's adopt): a rejected read changes nothing and leaves the floor. Only a read installed there
    // may clear it. A read below the floor keeps conflict actions disabled until one covers it.
    if (adopt(result.data)) { update((current) => afterDraftRead(current, result.data)); return result.data; }
    if (!covers(result.data, floorRef.current)) { update(() => ({ refreshFailed: true })); setReadFailures((count) => count + 1); }
    return null;
  }, [projectId, draftId, adopt, onAccessChanged, update, invalidate, fence]);

  useSyncReader(reload); // polling adopts through this same gated read
  useSyncSavedDraft(savedDraft); // remote previews are validated against what was adopted

  const run = useCallback(async (command: GraphCommand): Promise<RunOutcome> => {
    if (!editable) return readOnly;
    const base = saved.current;
    let queued: ReturnType<typeof enqueue>;
    try { queued = enqueue(latest.current, base, command, undefined, floorRef.current); } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      return { ok: false, code: error.code, message: projectErrors[error.code].message, uncertain: false, ...(error.details ? { details: error.details } : {}) };
    }
    const { entries, createdIds, versions, retiredIds, documentRevision } = queued;
    // Our own change may advance records other buffers were typed against. (Endpoint choices are checked against the
    // connection itself when applied: see endpointGuard.)
    change((current) => withEntries(current, base, entries, floorRef.current), (current) => ({ buffers: follow(current.buffers, versions) }));
    return { ok: true, result: { createdIds, versions, retiredIds, documentRevision } };
  }, [editable, change]);

  /**
   * The write barrier. Authority comes from the status controller, never from an earlier answer: after focus, reconnect,
   * a failed request or a draft change it waits for a fresh status read. A new batch needs an ACTIVE project, an owner or
   * editor and the draft it was made on; an uncertain retry only needs the person to still be a member (server guards stay
   * final). Null admits the write; otherwise the reason. DENIED means the shell is dropping the project or recovering, and says so meanwhile.
   */
  const admit = useCallback(async (write: boolean, target: string): Promise<Admission> => {
    const authority = await beforeWrite();
    if (authority.kind === "unavailable") return { blocked: { code: "UNAVAILABLE", message: "Not saved. We couldn’t reach ScopeRoom." } };
    if (authority.kind === "denied") return { blocked: { code: "DENIED", message: "Checking your access…" } };
    const stillCurrent = fence(authority.generation);
    if (!stillCurrent()) return { blocked: { code: "DRAFT_REPLACED", message: projectErrors.DRAFT_REPLACED.message } };
    if (write) {
      const { role: current, status, currentDraftId } = authority.status;
      if (currentDraftId !== target) return { blocked: { code: "DRAFT_REPLACED", message: projectErrors.DRAFT_REPLACED.message } };
      if (status !== "ACTIVE" || (current !== "OWNER" && current !== "EDITOR")) return { blocked: { code: "FORBIDDEN", message: "Not saved. This project is read-only now." } };
    }
    return { blocked: null, stillCurrent };
  }, [beforeWrite, fence]);

  /**
   * One flush: start a save of the queued changes if none is pending, then send its batches one after another, and
   * then anything queued meanwhile. Stops (false) at an unconfirmed or refused batch, or while another request is in flight.
   */
  const flush = useCallback(async (): Promise<boolean> => {
    let sent = false;
    // An acknowledged save always ends with the re-read and "All changes saved", even when this provider unmounted meanwhile.
    const finish = async () => { await reload(); update(() => ({ save: { state: "saved", message: "" } })); };
    for (;;) {
      if (!mounted.current || inFlight.current) { if (sent) await finish(); return false; }
      const waiting = latest.current.sending;
      if (waiting?.state === "refused") return false;
      if (!waiting && !latest.current.entries.length) break;
      if (!editable && waiting?.state !== "uncertain") return false;
      // Before every new batch and every retry of an unconfirmed one. Nothing between this check and the request awaits.
      const { blocked, stillCurrent } = await admit(waiting?.state !== "uncertain", waiting ? waiting.draftId : saved.current.id);
      if (blocked) {
        update(() => ({ save: { state: "failed", message: blocked.message } }));
        return false;
      }
      // Recheck right before the request: the person may have discarded, undone or unmounted, or the generation may have been
      // replaced, while the barrier waited. Start over from the current state (and a fresh barrier).
      if (!mounted.current || inFlight.current || latest.current.sending?.key !== waiting?.key || !stillCurrent()) continue;
      if (!latest.current.sending) {
        if (!editable) return false;
        const base = saved.current, key = crypto.randomUUID();
        change((current) => startSave(current, base, key, floorRef.current));
        if (!latest.current.sending) {
          // Not started: the result would go over the draft's size limit (the server would refuse it every time).
          if (latest.current.entries.length) {
            update(() => ({ save: { state: "failed", message: "These changes would make the draft too large, so they weren’t saved. Undo some of them." } }));
            return false;
          }
          continue; // only steps dropped back where they were: nothing to send
        }
      }
      const sending: Sending = latest.current.sending!;
      const { key, draftId: target } = sending;
      const mark = (state: Sending["state"], extra: Partial<Sending> = {}) => (current: Outbox) =>
        current.sending?.key === key ? { ...current, sending: { ...current.sending, state, ...extra } } : current;
      inFlight.current = key;
      change(mark("sending"), () => ({ request: key, save: { state: "saving", message: "" } }));
      const result = await apiMutate<ChangesResult>(`/api/projects/${projectId}/drafts/${target}/changes`, key, wireBody(sending.batches[0]!));
      if (inFlight.current === key) inFlight.current = null;
      // The outcome and the lock's release land together, so no render shows this batch as sent but unlocked.
      const release = (current: StudioUi) => (current.request === key ? { request: null } : {});
      if (sessionEnded(result)) { update(release); return false; }
      if (result.ok) {
        const receipt = result.data, nextKey = crypto.randomUUID();
        change((current) => (current.sending?.key === key ? acknowledged(current, nextKey) : current),
          (current) => ({ ...release(current), acknowledgedRevisions: requireDraftRevision(current.acknowledgedRevisions, receipt) }));
        sent = true;
        continue;
      }
      if (result.uncertain) {
        invalidate(); // the API may be down: the retry waits for a status read
        change(mark("uncertain"), (current) => ({ ...release(current), save: { state: "failed", message: "We couldn’t confirm your changes." } }));
        return false;
      }
      // A refusal usually means newer saved data. It is read before the refusal is shown, so the note compares the
      // person's changes with it and "Apply my changes again" replays on exactly what was compared. The lock stays
      // until then ("Saving…"), so nothing else is sent in between.
      if (accessCodes.has(result.code)) onAccessChanged();
      else await reload();
      change(mark("refused", { code: result.code, message: result.message }), (current) => ({ ...release(current), save: { state: "failed", message: "Your changes weren’t saved." } }));
      return false;
    }
    if (sent) await finish();
    // Editing remains enabled during the final read; a switch must still guard anything queued in that window.
    return pendingCount(latest.current) === 0;
  }, [editable, projectId, change, update, reload, onAccessChanged, admit, invalidate]);

  // Saves run one after another: a Save pressed during another waits for it, then sends what is left.
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveChanges = useCallback(() => (chain.current = chain.current.then(flush, flush)), [flush]);

  /** Native append uses the Studio's write barrier and receipt floor, never a graph command or preview draft. */
  const importFlow = useCallback(async (previewId: string, input: { draftId: string; previewHash: string }, key: string): Promise<Outcome<ImportApplyResult>> => {
    const invocation = fence();
    const current = () => mounted.current && invocation();
    const attempt = uiRef.current.nativeImport?.record.attempt;
    const retry = Boolean(attempt && attempt.key === key && attempt.draftId === input.draftId && attempt.previewHash === input.previewHash);
    // No retry POST means no new evidence about the original unknown effect. Current denial still clears protected data.
    const refused = (code: string, message: string): Outcome<ImportApplyResult> => ({ ok: false, code, message, uncertain: retry && !["DENIED", "UNAUTHENTICATED"].includes(code) });
    const guard = () => importBlocker({ ...uiRef.current, outbox: latest.current }, dragging.current);
    if (inFlight.current) return refused("BUSY", busyOutcome.message);
    if (!retry && !editable) return readOnly;
    let reason = guard();
    if (reason) return refused("LOCAL_CHANGES", reason);
    if (!await saveChanges()) return refused("LOCAL_CHANGES", "Resolve the unsaved changes in the Studio before importing.");
    if (!current()) return refused("DRAFT_REPLACED", "The project changed. Recover this import when you return.");
    reason = guard();
    if (reason || pendingCount(latest.current)) return refused("LOCAL_CHANGES", reason ?? "New edits are waiting in the Studio. Resolve them before importing.");
    if (inFlight.current) return refused("BUSY", busyOutcome.message);
    inFlight.current = key;
    update(() => ({ request: key }));
    try {
      const { blocked, stillCurrent } = await admit(!retry, input.draftId);
      if (!current()) return refused("DRAFT_REPLACED", "The project changed. Recover this import when you return.");
      if (blocked) return refused(blocked.code, blocked.message);
      reason = guard();
      if (reason || pendingCount(latest.current)) return refused("LOCAL_CHANGES", reason ?? "New edits are waiting in the Studio. Resolve them before importing.");
      if (!stillCurrent()) return refused("DRAFT_REPLACED", projectErrors.DRAFT_REPLACED.message);
      // Pin before sending, including when this instance is subsequently unmounted.
      const local = uiRef.current.nativeImport;
      if (!local || local.record.previewId !== previewId || local.record.draftId !== input.draftId || local.record.previewHash !== input.previewHash) return refused("IMPORT_PREVIEW_CHANGED", "Recover the original preview before importing.");
      const record = { ...local.record, attempt: { key, ...input } };
      if (!persistImport(record)) return refused("IMPORT_STORAGE_UNAVAILABLE", importStorageError);
      update(() => ({ nativeImport: { ...local, record, state: "Applying", message: "" } }));
      const result = await apiMutate<ImportApplyResult>(`/api/projects/${projectId}/flow-imports/${previewId}/apply`, key, input);
      // Fence before session teardown, receipt adoption and reload: a late 401 must not end the next account.
      if (!current() || !stillCurrent()) return { ok: false, code: "UNAVAILABLE", message: "Recover the original import when you return.", uncertain: true };
      if (sessionEnded(result)) return refused("UNAUTHENTICATED", "");
      if (result.ok) {
        if (result.data.draftId === saved.current.id) floorRef.current = requireDraftRevision(floorRef.current ? { [input.draftId]: floorRef.current } : {}, result.data)[input.draftId];
        update((value) => ({ acknowledgedRevisions: requireDraftRevision(value.acknowledgedRevisions, result.data) }));
        if (result.data.draftId === saved.current.id) await reload(stillCurrent);
        return { ok: true, result: result.data };
      }
      if (result.uncertain) invalidate();
      if (accessCodes.has(result.code)) onAccessChanged();
      return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
    } finally {
      if (inFlight.current === key) inFlight.current = null;
      update((value) => ({ ...(value.request === key ? { request: null } : {}), ...(value.nativeImport?.record.attempt?.key === key && value.nativeImport.state === "Applying" ? { nativeImport: { ...value.nativeImport, message: "We couldn’t confirm the import. Retry the same request or recover its status." } } : {}) }));
    }
  }, [admit, editable, fence, invalidate, onAccessChanged, projectId, reload, saveChanges, update]);

  const moveSteps = useCallback(async (flowId: string, targets: Placement[], { save: saveNow = false, joined = false } = {}) => {
    if (!editable || !targets.length) return;
    const base = saved.current;
    change((current) => addDrop(current, base, flowId, targets, joined, floorRef.current));
    if (saveNow) await saveChanges();
  }, [editable, change, saveChanges]);

  /**
   * After a refused save: replay every unsaved change on the saved draft the person has been shown (the refusal re-read
   * it, and the note compared it with their changes), listing any that no longer apply, then save. It never re-reads
   * first: a change someone makes after the comparison refuses this save again and is shown in turn.
   */
  const applyAgain = useCallback(async () => {
    if (!editable || inFlight.current || latest.current.sending?.state !== "refused") return;
    const fresh = saved.current;
    // Rebasing onto a saved draft below the acknowledged floor would drop an acknowledged edit from view.
    if (!covers(fresh, floorRef.current)) return;
    const names = optimistic(latest.current, fresh, floorRef.current).document;
    const rebased = rebase(latest.current, fresh, names);
    change(() => rebased, () => ({ save: { state: "idle", message: "" } }));
    await saveChanges();
  }, [editable, change, saveChanges]);
  const discardChanges = useCallback(() => {
    if (inFlight.current) return;
    change(discardOutbox, () => ({ save: { state: "idle", message: "" } }));
    void reload();
  }, [change, reload]);
  const dismissDropped = useCallback(() => change((current) => ({ ...current, dropped: [] })), [change]);
  // Keeping theirs for the last conflicting change leaves nothing refused: the failure status goes with it.
  const keepTheirs = useCallback((target: ConflictTarget) => change((current) => keepTheirsChange(current, target),
    (current) => (keepTheirsChange(current.outbox, target).sending ? {} : { save: { state: "idle", message: "" } })), [change]);
  const undo = useCallback(() => { setRedoCleared(false); change(undoChange); }, [change]);
  const dismissRedoCleared = useCallback(() => setRedoCleared(false), []);
  const redo = useCallback(() => change(redoChange), [change]);

  /** An arrangement save (Arrange's Apply), on the same one-request-at-a-time lock as the batch save. */
  const place = useCallback(async (command: ArrangeFlow, key: string = crypto.randomUUID()): Promise<Outcome<PositionResult>> => {
    if (inFlight.current) return busyOutcome;
    if (!editable) return readOnly;
    inFlight.current = key;
    update(() => ({ request: key }));
    try {
      const { blocked, stillCurrent } = await admit(true, draftId);
      if (blocked) return { ok: false, code: blocked.code, message: blocked.message, uncertain: false };
      if (!stillCurrent()) return { ok: false, code: "DRAFT_REPLACED", message: projectErrors.DRAFT_REPLACED.message, uncertain: false };
      const result = await apiMutate<PositionResult>(`/api/projects/${projectId}/drafts/${draftId}/positions`, key, command);
      if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
      if (result.ok) {
        // A position receipt proves the layout revision; the document revision floor stays as it was.
        update((current) => ({ acknowledgedRevisions: requireDraftRevision(current.acknowledgedRevisions, { draftId: result.data.draftId, documentRevision: 0, layoutRevision: result.data.layoutRevision }) }));
        await reload();
        return { ok: true, result: result.data };
      }
      if (result.uncertain) invalidate();
      if (accessCodes.has(result.code)) onAccessChanged();
      else if (!result.uncertain) await reload();
      return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
    } finally {
      if (inFlight.current === key) inFlight.current = null;
      update((current) => (current.request === key ? { request: null } : {}));
    }
  }, [editable, projectId, draftId, update, reload, onAccessChanged, admit, invalidate]);

  /** A nonmutating arrangement preview: no key, no lock, and a certain refusal re-reads the draft it was stale against. */
  const preview = useCallback(async (request: ArrangementRequest): Promise<Outcome<ArrangementPreview>> => {
    const result = await apiMutate<ArrangementPreview>(`/api/projects/${projectId}/drafts/${draftId}/arrangement-preview`, null, request);
    if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
    if (result.ok) return { ok: true, result: result.data };
    if (accessCodes.has(result.code)) onAccessChanged();
    else if (!result.uncertain) await reload();
    return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
  }, [projectId, draftId, reload, onAccessChanged]);

  // Autosave: one timer per open project (this provider is keyed by project, so unmount clears it). It runs while
  // changes wait, nothing is in flight and no save awaits the person's choice; a tick during a drag is skipped.
  // Hidden tabs keep it: the browser throttles the timer, and saving there still narrows what a closed tab could lose.
  const dragActive = useCallback((active: boolean) => { dragging.current = active; }, []);
  const autosave = useRef(saveChanges);
  useEffect(() => {
    autosave.current = saveChanges;
    if (!saveRef) return;
    saveRef.current = saveChanges;
    return () => { if (saveRef.current === saveChanges) saveRef.current = null; };
  }, [saveChanges, saveRef]);
  const waiting = outbox.entries.length > 0 || outbox.sending?.state === "waiting";
  const unresolved = outbox.sending?.state === "uncertain" || outbox.sending?.state === "refused";
  useEffect(() => {
    if (!editable || !waiting || busy || unresolved) return;
    const timer = window.setInterval(() => { if (!dragging.current) void autosave.current(); }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [editable, waiting, busy, unresolved]);

  const replayed = useMemo(() => (editable ? replay(outbox, savedDraft, floor) : { draft: savedDraft, skipped: [] }), [editable, outbox, savedDraft, floor]);
  const { draft, skipped } = replayed;
  // The flow shown (if others can see it in the saved draft) and the selection are shared as an advisory claim; canvas and List use this one selection, and it never affects saving.
  const shown = currentFlow(draft.document, ui.flowId);
  const shownFlowId = shown && savedDraft.document.flows[shown.id] ? shown.id : null;
  useEffect(() => { setPresence(claimOf(shownFlowId, ui.selection)); }, [setPresence, shownFlowId, ui.selection]);
  const unsaved = pendingCount(outbox) > 0;
  const canUndo = editable && outbox.entries.length > 0, canRedo = editable && outbox.redo.length > 0;
  const value = useMemo<Studio>(() => ({
    projectId, draft, savedDraft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, readFailures, frozen, redoCleared, dismissRedoCleared, run, moveSteps, saveChanges, unsaved,
    applyAgain, discardChanges, dismissDropped, keepTheirs, skipped, undo, redo, canUndo, canRedo, place, preview, importFlow, reload, dragActive, inspect: onInspect,
  }), [projectId, draft, savedDraft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, readFailures, frozen, redoCleared, dismissRedoCleared, run, moveSteps, saveChanges, unsaved,
    applyAgain, discardChanges, dismissDropped, keepTheirs, skipped, undo, redo, canUndo, canRedo, place, preview, importFlow, reload, dragActive, onInspect]);
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

/** Dialogs, the List and the inspector queue their commands through the same local path. */
export function useCommandSubmit() {
  return useStudio().run;
}

/** What to tell someone whose change was refused locally. */
export function explain(outcome: Extract<RunOutcome, { ok: false }>): string {
  if (outcome.code === "STALE_DOCUMENT_REVISION") return "The flow changed while you were working. Review it, then try again.";
  return outcome.message;
}

/** Studio forms: Enter never submits during IME composition, and Ctrl/Cmd+Enter submits from a text area (UI00). */
export function formKeys(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter") return;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.preventDefault(); return; } // 229: WebKit's IME-confirming Enter
  if ((event.ctrlKey || event.metaKey) && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.currentTarget.requestSubmit(); }
}

/** Always mounted, so the one message is announced when it appears; saving is never blocked by it. */
export function LiveStatus() {
  const delayed = useSync().liveState === "degraded";
  return <span className={delayed ? "muted" : "sr-only"} role="status">{delayed ? "Live updates delayed" : ""}</span>;
}

/**
 * A read that has not landed: a failed or below-the-floor saved read (or a failing status poll). Polling keeps trying, so
 * the first line just says so; a screen reader hears it once, not per poll. After two consecutive failures (the poll's
 * backoff at its 30 s cap) it becomes the recovery line with Retry.
 */
export function ReadRecovery() {
  const { reload, save, refreshFailed, readFailures } = useStudio();
  const { failures, revalidate } = useSync();
  if (!refreshFailed) return null;
  const gaveUp = readFailures >= 2 || failures >= 2;
  const retry = () => { void reload(); if (failures) void revalidate("manual"); };
  return <>
    <span className={gaveUp ? "status-error" : "muted"} role="status">{save.state === "saved" ? "Changes saved. " : ""}{gaveUp ? "Couldn't refresh saved changes" : "Refreshing saved changes…"}</span>
    {gaveUp && <button type="button" className="button small" onClick={retry}>Retry</button>}
  </>;
}
