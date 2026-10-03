import { isDirty } from "../../studio/ui/buffers.ts";
import type { StudioUi } from "../../studio/ui/studio-ui.ts";

/** Header Save drains completed outbox edits; these inputs still need their own explicit form action. */
export function exportSaveBlocker(ui: StudioUi, dragging: boolean): string | null {
  if (dragging) return "Finish the active drag before saving for export.";
  if ([...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers), ...Object.values(ui.positionBuffers)].some(isDirty)) return "Submit or discard your typed text, coordinates and connection choices in the Studio first. Save only submits completed queued edits.";
  if (ui.outbox.sending?.state === "uncertain" || ui.outbox.sending?.state === "refused") return "Resolve the unconfirmed or refused save in the Studio first.";
  return null;
}
