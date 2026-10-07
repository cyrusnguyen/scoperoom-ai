// Per-project UI store (UI00 "Per-project UI state"), held in memory above the keyed project subtree.
// Unsaved field values live here, so closing the panel or navigating away never drops them silently.
import { discardOutbox } from "../../studio/ui/outbox.ts";
import { defaultStudioUi, studioDirtyCount, type StudioUi } from "../../studio/ui/studio-ui.ts";

type AiRequestBase = { projectId: string; draftId: string; key: string; body: Record<string, unknown>; };
export type AiRequest =
  | (AiRequestBase & { kind: "start"; submittedText: string })
  | (AiRequestBase & { kind: "apply"; runId: string })
  | (AiRequestBase & { kind: "discard" | "cancel"; runId: string });
export type AiUi = { instruction: string; action: "PROPOSE_FLOW" | "REFINE_FLOW_SELECTION"; selectedRunId: string | null; pendingRequest: AiRequest | null; applyPhase?: { key: string; projectId: string; runId: string; state: "uncertain" | "acknowledged" | "adopted"; draftId: string; documentRevision?: number; layoutRevision?: number } };
export type RightTab = "details" | "ai" | "specs";
export type SpecsSelection = { kind: "source"; sourceId: string; versionId: string | null; back: SpecsSelection } | null;
export type SpecsUi = { selected: SpecsSelection; message: string };
export type ProjectUi = { rightOpen: boolean; rightMounted: boolean; rightTab: RightTab; drafts: Record<string, string>; ai: AiUi; specs: SpecsUi } & StudioUi;
export type UiStore = Record<string, ProjectUi>;

export const defaultAiUi: AiUi = { instruction: "", action: "PROPOSE_FLOW", selectedRunId: null, pendingRequest: null };
export const defaultSpecsUi: SpecsUi = { selected: null, message: "" };
export const defaultUi: ProjectUi = { rightOpen: false, rightMounted: false, rightTab: "details", drafts: {}, ai: defaultAiUi, specs: defaultSpecsUi, ...defaultStudioUi };

export function uiFor(store: UiStore, projectId: string | undefined): ProjectUi {
  return (projectId && store[projectId]) || defaultUi;
}

/** Opening mounts the panel for this project; closing only hides it, so its in-memory state survives. */
export function setRightOpen(store: UiStore, projectId: string, open: boolean): UiStore {
  const current = uiFor(store, projectId);
  return { ...store, [projectId]: { ...current, rightOpen: open, rightMounted: current.rightMounted || open } };
}

export function setRightTab(store: UiStore, projectId: string, rightTab: RightTab): UiStore {
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

/** Reload or close also protects pending AI receipts retained only in memory. */
export function anyDirty(store: UiStore): boolean {
  return Object.keys(store).some((projectId) => dirtyCount(store, projectId) > 0 || store[projectId].ai.pendingRequest !== null);
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

export function currentAiRun(ui: AiUi, requested: string | null, latest?: string): string | null {
  return ui.pendingRequest && ui.pendingRequest.kind !== "start" ? ui.pendingRequest.runId : requested ?? ui.selectedRunId ?? latest ?? null;
}

/** A missing detail never settles an in-memory request or Apply receipt. */
export function recoverUnavailableCurrentRun(ui: AiUi, ticket: { id: string; isLive: () => boolean }): AiUi {
  const unresolvedApply = ui.applyPhase?.state === "uncertain" || ui.applyPhase?.state === "acknowledged";
  return ticket.isLive() && ui.selectedRunId === ticket.id && !ui.pendingRequest && !unresolvedApply ? { ...ui, selectedRunId: null } : ui;
}

export function acknowledgedApplyCovered(phase: NonNullable<AiUi["applyPhase"]>, saved: Pick<import("../../drafts/contracts/scope-document").DraftView, "id" | "documentRevision" | "layoutRevision">): boolean {
  return phase.state === "acknowledged" && saved.id === phase.draftId && saved.documentRevision >= (phase.documentRevision ?? Infinity) && saved.layoutRevision >= (phase.layoutRevision ?? Infinity);
}

/** Retain only the trusted result of this exact Apply invocation, never generic draft floors. */
export function retainAiApply(current: AiUi, request: AiRequest, receipt?: import("../../proposals/contracts/tasks").AppliedRun & { adopted?: boolean }): AiUi {
  const pending = current.pendingRequest;
  if (!receipt || request.kind !== "apply" || pending?.kind !== "apply" || pending.key !== request.key || pending.projectId !== request.projectId || pending.runId !== request.runId || pending.draftId !== request.draftId || receipt.runId !== request.runId || receipt.draftId !== request.draftId) return current;
  return { ...current, pendingRequest: receipt.adopted ? null : pending, applyPhase: { key: request.key, projectId: request.projectId, runId: receipt.runId, draftId: receipt.draftId, documentRevision: receipt.documentRevision, layoutRevision: receipt.layoutRevision, state: receipt.adopted ? "adopted" : "acknowledged" } };
}

/** A definitive refusal resolves this attempt only; late results cannot erase newer recovery. */
export function finishAiApply(current: AiUi, request: AiRequest): AiUi {
  const pending=current.pendingRequest, phase=current.applyPhase;
  if (request.kind !== 'apply' || pending?.kind !== 'apply' || pending.key !== request.key || pending.projectId !== request.projectId || pending.draftId !== request.draftId || pending.runId !== request.runId) return current;
  const matching=phase?.key === request.key && phase.projectId === request.projectId && phase.draftId === request.draftId && phase.runId === request.runId;
  return {...current,pendingRequest:null,...(matching ? {applyPhase:undefined} : {})};
}
