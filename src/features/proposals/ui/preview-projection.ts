import type { DraftView } from "@/features/drafts/contracts/scope-document";
import { usedIds } from "../../drafts/domain/graph.ts";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import { applyProposal } from "../domain/proposal-diff.ts";
import type { RunView } from "../contracts/tasks.ts";

/** Projects an applicable proposal onto the coherent saved draft without changing Studio state or persisted data. */
export function projectProposalPreview(saved: DraftView, status: Pick<ProjectStatusView, "status" | "currentDraftId" | "documentRevision" | "layoutRevision" | "approvedSnapshotId">, run: RunView, inspection = false): DraftView | null {
  const capture = run.capture, result = run.result;
  if (inspection || !capture || !result || result.kind !== "proposal" || run.state !== "SUCCEEDED" || run.disposition !== "AVAILABLE" || run.applicability !== "APPLICABLE"
    || status.status !== "ACTIVE" || saved.status !== "EDITABLE"
    || saved.id !== status.currentDraftId || saved.id !== run.draftId || saved.id !== capture.draftId
    || saved.documentRevision !== status.documentRevision || saved.documentRevision !== run.documentRevision || saved.documentRevision !== capture.documentRevision
    || saved.layoutRevision < status.layoutRevision // Apply places new steps on the newest saved layout; a saved read behind the status would preview other positions.
    || status.approvedSnapshotId !== run.parentSnapshotId || status.approvedSnapshotId !== capture.parentSnapshotId) return null;
  const used = usedIds(saved.document);
  let sequence = 0;
  const temporaryId = () => {
    let id = "";
    do { id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; } while (used.has(id));
    used.add(id);
    return id;
  };
  try {
    const applied = applyProposal(saved, capture, result, result.operations.map((operation) => operation.id), temporaryId);
    return { ...saved, document: applied.document, layout: applied.layout };
  } catch { return null; }
}

export function newApplyBlocker(input: { canWrite: boolean; editable: boolean; authorityConfirmed: boolean; busy: boolean; dirty: boolean; blockedByPending: boolean; preview: boolean }): string {
  if (!input.authorityConfirmed) return "Current project access could not be confirmed. Retry AI reads before applying.";
  if (!input.canWrite || !input.editable) return "This project is read-only. Project editors can apply in an active project.";
  if (input.busy) return "Another Studio or AI change is still in progress.";
  if (input.dirty) return "Save or discard the unsaved Studio changes before applying.";
  if (input.blockedByPending) return "Resolve the pending AI request before changing this proposal.";
  return input.preview ? "" : "Full preview is unavailable because this saved draft no longer matches the captured proposal. Capture-only details remain below.";
}
