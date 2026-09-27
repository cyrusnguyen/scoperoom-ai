// Per-project UI store (UI00 "Per-project UI state"), held in memory above the keyed project subtree.
// Unsaved field values live here, so closing the panel or navigating away never drops them silently.
export type ProjectUi = { rightOpen: boolean; rightMounted: boolean; drafts: Record<string, string> };
export type UiStore = Record<string, ProjectUi>;

export const defaultUi: ProjectUi = { rightOpen: false, rightMounted: false, drafts: {} };

export function uiFor(store: UiStore, projectId: string | undefined): ProjectUi {
  return (projectId && store[projectId]) || defaultUi;
}

/** Opening mounts the panel for this project; closing only hides it, so its in-memory state survives. */
export function setRightOpen(store: UiStore, projectId: string, open: boolean): UiStore {
  const current = uiFor(store, projectId);
  return { ...store, [projectId]: { ...current, rightOpen: open, rightMounted: current.rightMounted || open } };
}

/** Records an unsaved value; `undefined` means the field matches its saved value again. */
export function setDraft(store: UiStore, projectId: string, key: string, value: string | undefined): UiStore {
  const current = uiFor(store, projectId);
  const drafts = { ...current.drafts };
  if (value === undefined) delete drafts[key];
  else drafts[key] = value;
  return { ...store, [projectId]: { ...current, drafts } };
}

export function dirtyCount(store: UiStore, projectId: string | undefined): number {
  return Object.keys(uiFor(store, projectId).drafts).length;
}

export function anyDirty(store: UiStore): boolean {
  return Object.values(store).some((ui) => Object.keys(ui.drafts).length > 0);
}

export function discardDrafts(store: UiStore, projectId: string): UiStore {
  return { ...store, [projectId]: { ...uiFor(store, projectId), drafts: {} } };
}

/** Access loss or leaving: forget everything held for that project. */
export function dropProject(store: UiStore, projectId: string): UiStore {
  const next = { ...store };
  delete next[projectId];
  return next;
}
