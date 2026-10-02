import type { ImportApplyInput, ImportPreviewView } from "../contracts/import.ts";
import { isDirty } from "../../studio/ui/buffers.ts";
import type { StudioUi } from "../../studio/ui/studio-ui.ts";

export const IMPORT_STORAGE_PREFIX = "scoperoom:flow-import:";
export const importStorageError = "Browser session storage is unavailable. Reload recovery is not guaranteed. Restore session storage before inspecting or applying; recover the original import status if a request was already sent.";
export type ImportRecord = {
  actorId: string; projectId: string; draftId: string; previewId: string; createKey: string; discardKey: string;
  fingerprint: string; previewHash?: string; attempt?: ImportApplyInput;
};
export type NativeImportState = {
  record: ImportRecord; preview: ImportPreviewView | null; file: File | null;
  state: "Validating" | "Ready" | "Invalid" | "Applying" | "Applied" | "Expired" | "Stale" | "Access lost";
  message: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
export const importStorageKey = (actorId: string, projectId: string) => `${IMPORT_STORAGE_PREFIX}${actorId.toLowerCase()}:${projectId.toLowerCase()}`;
export function storedImportRecord(record: ImportRecord): string {
  const { actorId, projectId, draftId, previewId, createKey, discardKey, fingerprint, previewHash, attempt } = record;
  return JSON.stringify({ actorId, projectId, draftId, previewId, createKey, discardKey, fingerprint, previewHash,
    ...(attempt ? { attempt: { key: attempt.key, draftId: attempt.draftId, previewHash: attempt.previewHash } } : {}) });
}
export function parseImportRecord(raw: string | null, actorId: string, projectId: string): ImportRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ImportRecord;
    if (value.actorId.toLowerCase() !== actorId.toLowerCase() || value.projectId.toLowerCase() !== projectId.toLowerCase() || ![value.actorId, value.projectId, value.draftId, value.previewId, value.createKey, value.discardKey].every((id) => typeof id === "string" && uuid.test(id)) || !hash.test(value.fingerprint)) return null;
    if (value.previewHash !== undefined && !hash.test(value.previewHash)) return null;
    if (value.attempt && (!uuid.test(value.attempt.key) || value.attempt.draftId !== value.draftId || value.attempt.previewHash !== value.previewHash)) return null;
    return JSON.parse(storedImportRecord(value)) as ImportRecord;
  } catch { return null; }
}
export function persistImport(record: ImportRecord): boolean {
  try { sessionStorage.setItem(importStorageKey(record.actorId, record.projectId), storedImportRecord(record)); return true; } catch { return false; }
}
export function clearImport(record: Pick<ImportRecord, "actorId" | "projectId">) {
  try { sessionStorage.removeItem(importStorageKey(record.actorId, record.projectId)); } catch { /* Storage can be disabled. */ }
}
export function clearImportSessions() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(IMPORT_STORAGE_PREFIX)) sessionStorage.removeItem(key); } catch { /* Storage can be disabled. */ }
}
/** Completed queued commands can be saved; typed values and unresolved receipts need the person's decision. */
export function importBlocker(ui: Pick<StudioUi, "buffers" | "endpointBuffers" | "positionBuffers" | "outbox">, dragging: boolean): string | null {
  if (dragging) return "Finish the active drag in the Studio before importing.";
  if ([...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers), ...Object.values(ui.positionBuffers)].some(isDirty)) return "Resolve your typed text, coordinates and connection choices in the Studio, or explicitly discard them there before importing. Save only submits completed queued edits.";
  if (ui.outbox.sending?.state === "uncertain" || ui.outbox.sending?.state === "refused") return "Resolve the unconfirmed or refused save in the Studio before importing.";
  if (ui.outbox.redo.length) return "Resolve redo work in the Studio, or explicitly discard it before importing.";
  return null;
}
