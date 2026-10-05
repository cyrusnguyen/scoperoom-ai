// Per-project UI store (UI00 "Per-project UI state"), held in memory above the keyed project subtree.
// Unsaved field values live here, so closing the panel or navigating away never drops them silently.
import { discardOutbox } from "../../studio/ui/outbox.ts";
import { defaultStudioUi, studioDirtyCount, type StudioUi } from "../../studio/ui/studio-ui.ts";

type AiRequestBase = { projectId: string; draftId: string; key: string; body: Record<string, unknown>; };
export type AiRequest =
  | (AiRequestBase & { kind: "start"; submittedText: string })
  | (AiRequestBase & { kind: "apply"; runId: string })
  | (AiRequestBase & { kind: "discard" | "cancel"; runId: string });
export type AiUi = { instruction: string; action: "PROPOSE_FLOW" | "REFINE_FLOW_SELECTION"; selectedRunId: string | null; pendingRequest: AiRequest | null };
export type ProjectUi = { rightOpen: boolean; rightMounted: boolean; rightTab: "details" | "ai"; drafts: Record<string, string>; ai: AiUi } & StudioUi;
export type UiStore = Record<string, ProjectUi>;

export const defaultAiUi: AiUi = { instruction: "", action: "PROPOSE_FLOW", selectedRunId: null, pendingRequest: null };
export const defaultUi: ProjectUi = { rightOpen: false, rightMounted: false, rightTab: "details", drafts: {}, ai: defaultAiUi, ...defaultStudioUi };

export function uiFor(store: UiStore, projectId: string | undefined): ProjectUi {
  return (projectId && store[projectId]) || defaultUi;
}

/** Opening mounts the panel for this project; closing only hides it, so its in-memory state survives. */
export function setRightOpen(store: UiStore, projectId: string, open: boolean): UiStore {
  const current = uiFor(store, projectId);
  return { ...store, [projectId]: { ...current, rightOpen: open, rightMounted: current.rightMounted || open } };
}

export function setRightTab(store: UiStore, projectId: string, rightTab: ProjectUi["rightTab"]): UiStore {
  const current = uiFor(store, projectId);
  return { ...store, [projectId]: { ...current, rightOpen: true, rightMounted: true, rightTab } };
}

/** Records an unsaved value; `undefined` means the field matches its saved value again. */
export function setDraft(store: UiStore, projectId: string, key: string, value: string | undefined): UiStore {
  const current = uiFor(store, projectId);
  const drafts = { ...current.drafts };
  if (value === undefined) delete drafts[key];
  else drafts[key] = value;
  return { ...store, [projectId]: { ...current, drafts } };
}

/** Applies a change computed from the project's current UI state, so async callers never write a stale copy. */
export function updateUi(store: UiStore, projectId: string, change: (ui: ProjectUi) => Partial<ProjectUi>): UiStore {
  const current = uiFor(store, projectId);
  return { ...store, [projectId]: { ...current, ...change(current) } };
}

/** Unsaved Details fields plus unsaved Studio fields and changes (an unconfirmed or refused save still counts). */
export function dirtyCount(store: UiStore, projectId: string | undefined): number {
  const ui = uiFor(store, projectId);
  return Object.keys(ui.drafts).length + studioDirtyCount(ui);
}

export function anyDirty(store: UiStore): boolean {
  return Object.keys(store).some((projectId) => dirtyCount(store, projectId) > 0);
}

/**
 * Discard local input only: typed values and unsaved changes (including a refused save). A save that is in flight or
 * unconfirmed may already have committed, so it stays retryable with its key, and its status stays with it.
 */
export function discardDrafts(store: UiStore, projectId: string): UiStore {
  const current = uiFor(store, projectId);
  const outbox = discardOutbox(current.outbox);
  return { ...store, [projectId]: { ...current, drafts: {}, buffers: {}, endpointBuffers: {}, positionBuffers: {}, outbox, save: outbox.sending ? current.save : { state: "idle", message: "" } } };
}

/** Access loss or leaving: forget everything held for that project. */
export function dropProject(store: UiStore, projectId: string): UiStore {
  const next = { ...store };
  delete next[projectId];
  return next;
}
