"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import type { ErrorDetails } from "@/contracts/http";
import type { ChangesResult } from "@/features/drafts/contracts/changes";
import type { GraphCommand } from "@/features/drafts/contracts/commands";
import type { ArrangementPreview, ArrangementRequest, PositionCommand, PositionResult } from "@/features/drafts/contracts/positions";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import { GraphError } from "@/features/drafts/domain/graph";
import { projectErrors } from "@/features/projects/contracts/errors";
import type { ProjectAccessRole } from "@/features/projects/contracts/project";
import { follow } from "./buffers";
import {
  acknowledged, addDrop, discardOutbox, enqueue, optimistic, pendingCount, rebase, redo as redoChange, startSave, undo as undoChange, wireBody, withEntries,
  type Outbox, type Placement, type Sending,
} from "./outbox";
import { afterDraftRead, AUTOSAVE_MS, requireDraftRevision, type SaveState, type StudioUi } from "./studio-ui";

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
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  place: (command: PositionCommand, key?: string) => Promise<Outcome<PositionResult>>;
  preview: (request: ArrangementRequest) => Promise<Outcome<ArrangementPreview>>;
  reload: () => Promise<DraftView | null>;
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
export const staleCodes = new Set(["STALE_DOCUMENT_REVISION", "STALE_ENTITY_VERSION", "POSITION_CONFLICT", "DEPENDENCY_CONFLICT"]);
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
  adopt: (view: DraftView) => void; onAccessChanged: () => void; onInspect: () => void;
  /** Lets the shell save unsaved changes before a project switch. */
  saveRef?: RefObject<(() => Promise<boolean>) | null>; children: ReactNode;
}) {
  const { outbox, request, save, refreshFailed } = ui;
  // Another instance may still own the request after browser history remounts this keyed provider.
  const busy = Boolean(request);
  const draftId = savedDraft.id;
  const editable = !archived && (role === "OWNER" || role === "EDITOR");

  // Synchronous copies, so actions in one event (a shape's step and its drop point) and async saves see every change
  // already made; each render catches them up with the store, which also changes from outside (discard, remounts).
  const latest = useRef(outbox);
  const saved = useRef(savedDraft);
  const inFlight = useRef(request);
  const mounted = useRef(true);
  useLayoutEffect(() => { latest.current = outbox; }, [outbox]);
  useLayoutEffect(() => { saved.current = savedDraft; }, [savedDraft]);
  useLayoutEffect(() => { inFlight.current = request; }, [request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  /** One pure outbox change, applied to the synchronous copy now and to the store in order. */
  const change = useCallback((next: (current: Outbox) => Outbox, also?: (current: StudioUi) => Partial<StudioUi>) => {
    latest.current = next(latest.current);
    update((current) => ({ outbox: next(current.outbox), ...(also ? also(current) : {}) }));
  }, [update]);

  const reload = useCallback(async (): Promise<DraftView | null> => {
    const result = await apiRead<DraftView>(`/api/projects/${projectId}/drafts/${draftId}`);
    if (sessionEnded(result)) return null;
    update((current) => result.ok ? afterDraftRead(current, result.data) : { refreshFailed: true });
    if (result.ok) { adopt(result.data); return result.data; }
    if (result.status === 404) onAccessChanged();
    return null;
  }, [projectId, draftId, adopt, onAccessChanged, update]);

  const run = useCallback(async (command: GraphCommand): Promise<RunOutcome> => {
    if (!editable) return readOnly;
    const base = saved.current;
    let queued: ReturnType<typeof enqueue>;
    try { queued = enqueue(latest.current, base, command); } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      return { ok: false, code: error.code, message: projectErrors[error.code].message, uncertain: false, ...(error.details ? { details: error.details } : {}) };
    }
    const { entries, createdIds, versions, retiredIds, documentRevision } = queued;
    // Our own change may advance records other buffers were typed against. (Endpoint choices are checked against the
    // connection itself when applied: see endpointGuard.)
    change((current) => withEntries(current, base, entries), (current) => ({ buffers: follow(current.buffers, versions) }));
    return { ok: true, result: { createdIds, versions, retiredIds, documentRevision } };
  }, [editable, change]);

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
      if (!latest.current.sending) {
        if (!latest.current.entries.length) break;
        if (!editable) return false;
        const base = saved.current, key = crypto.randomUUID();
        change((current) => startSave(current, base, key));
        if (!latest.current.sending) continue; // only steps dropped back where they were: nothing to send
      }
      const sending: Sending = latest.current.sending!;
      if (sending.state === "refused") return false;
      // An admitted reader may still resolve an already-sent batch, but only with its exact key and body.
      if (!editable && sending.state !== "uncertain") return false;
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
        change(mark("uncertain"), (current) => ({ ...release(current), save: { state: "failed", message: "We couldn’t confirm your changes." } }));
        return false;
      }
      change(mark("refused", { code: result.code, message: result.message }), (current) => ({ ...release(current), save: { state: "failed", message: "Your changes weren’t saved." } }));
      if (accessCodes.has(result.code)) onAccessChanged();
      else await reload(); // a refusal usually means newer saved data; "Apply my changes again" replays on it
      return false;
    }
    if (sent) await finish();
    return true;
  }, [editable, projectId, change, update, reload, onAccessChanged]);

  // Saves run one after another: a Save pressed during another waits for it, then sends what is left.
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveChanges = useCallback(() => (chain.current = chain.current.then(flush, flush)), [flush]);

  const moveSteps = useCallback(async (flowId: string, targets: Placement[], { save: saveNow = false, joined = false } = {}) => {
    if (!editable || !targets.length) return;
    const base = saved.current;
    change((current) => addDrop(current, base, flowId, targets, joined));
    if (saveNow) await saveChanges();
  }, [editable, change, saveChanges]);

  /** After a refused save: re-read, replay every unsaved change on the newer draft (listing any that no longer apply), save. */
  const applyAgain = useCallback(async () => {
    if (!editable || inFlight.current || latest.current.sending?.state !== "refused") return;
    const fresh = await reload();
    if (!fresh || latest.current.sending?.state !== "refused") return;
    const names = optimistic(latest.current, saved.current).document;
    const rebased = rebase(latest.current, fresh, names);
    change(() => rebased, () => ({ save: { state: "idle", message: "" } }));
    await saveChanges();
  }, [editable, reload, change, saveChanges]);
  const discardChanges = useCallback(() => {
    if (inFlight.current) return;
    change(discardOutbox, () => ({ save: { state: "idle", message: "" } }));
    void reload();
  }, [change, reload]);
  const dismissDropped = useCallback(() => change((current) => ({ ...current, dropped: [] })), [change]);
  const undo = useCallback(() => change(undoChange), [change]);
  const redo = useCallback(() => change(redoChange), [change]);

  /** An arrangement save (Arrange's Apply), on the same one-request-at-a-time lock as the batch save. */
  const place = useCallback(async (command: PositionCommand, key: string = crypto.randomUUID()): Promise<Outcome<PositionResult>> => {
    if (inFlight.current) return busyOutcome;
    if (!editable) return readOnly;
    inFlight.current = key;
    update(() => ({ request: key }));
    try {
      const result = await apiMutate<PositionResult>(`/api/projects/${projectId}/drafts/${draftId}/positions`, key, command);
      if (sessionEnded(result)) return { ok: false, code: "UNAUTHENTICATED", message: "", uncertain: false };
      if (result.ok) {
        // A position receipt proves the layout revision; the document revision floor stays as it was.
        update((current) => ({ acknowledgedRevisions: requireDraftRevision(current.acknowledgedRevisions, { draftId: result.data.draftId, documentRevision: 0, layoutRevision: result.data.layoutRevision }) }));
        await reload();
        return { ok: true, result: result.data };
      }
      if (accessCodes.has(result.code)) onAccessChanged();
      else if (!result.uncertain) await reload();
      return { ok: false, code: result.code, message: result.message, uncertain: result.uncertain, ...(result.details ? { details: result.details } : {}) };
    } finally {
      if (inFlight.current === key) inFlight.current = null;
      update((current) => (current.request === key ? { request: null } : {}));
    }
  }, [editable, projectId, draftId, update, reload, onAccessChanged]);

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
  const dragging = useRef(false);
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

  const draft = useMemo(() => (editable ? optimistic(outbox, savedDraft) : savedDraft), [editable, outbox, savedDraft]);
  const unsaved = pendingCount(outbox) > 0;
  const canUndo = editable && outbox.entries.length > 0, canRedo = editable && outbox.redo.length > 0;
  const value = useMemo<Studio>(() => ({
    projectId, draft, savedDraft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, run, moveSteps, saveChanges, unsaved,
    applyAgain, discardChanges, dismissDropped, undo, redo, canUndo, canRedo, place, preview, reload, dragActive, inspect: onInspect,
  }), [projectId, draft, savedDraft, role, archived, editable, narrow, ui, update, busy, save, refreshFailed, run, moveSteps, saveChanges, unsaved,
    applyAgain, discardChanges, dismissDropped, undo, redo, canUndo, canRedo, place, preview, reload, dragActive, onInspect]);
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
  if (event.nativeEvent.isComposing) { event.preventDefault(); return; }
  if ((event.ctrlKey || event.metaKey) && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.currentTarget.requestSubmit(); }
}

/** A save whose follow-up read failed: say so, and offer the read again. */
export function ReadRecovery() {
  const { reload, save, refreshFailed } = useStudio();
  if (!refreshFailed) return null;
  return <>
    <span className="status-error" role="alert">{save.state === "saved" ? "Changes saved. " : ""}The latest draft could not load.</span>
    <button type="button" className="button small" onClick={() => void reload()}>Retry read</button>
  </>;
}
