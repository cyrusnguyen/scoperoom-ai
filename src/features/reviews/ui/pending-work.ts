import type { DraftView } from "../../drafts/contracts/scope-document.ts";
import type { DraftLayout } from "../../drafts/contracts/draft-layout.ts";
import type { ProjectStatusView } from "../../projects/contracts/project.ts";
import type { PublishedSnapshot } from "../contracts/review.ts";
import { agreedProjection } from "../domain/candidate.ts";
import { covers, type RevisionFloor } from "../../studio/ui/outbox.ts";

type PendingWork = { kind: "unavailable" } | { kind: "unapproved" } | { kind: "compared"; semantic: boolean; layout: boolean };
const sorted = <T>(records: Record<string, T>) => Object.entries(records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
// Compare the bounded saved geometry, not position counters or object insertion order.
const layoutMeaning = (layout: DraftLayout) => [
  sorted(layout.positions).map(([id, { x, y }]) => [id, x, y]), sorted(layout.directions),
  sorted(layout.edgeSides).map(([id, { from, to }]) => [id, from, to]),
];

/** The saved view and current approved baseline are independent of outbox replay and displayed history. */
export function savedPendingWork(saved: DraftView, baseline: PublishedSnapshot | null,
  status: Pick<ProjectStatusView, "currentDraftId" | "documentRevision" | "layoutRevision" | "approvedSnapshotId" | "baselineSequence">,
  floor: RevisionFloor | undefined, available: boolean): PendingWork {
  if (!available || saved.id !== status.currentDraftId || !covers(saved, status) || !covers(saved, floor)) return { kind: "unavailable" };
  if (!status.approvedSnapshotId) return { kind: "unapproved" };
  if (baseline?.snapshot.id !== status.approvedSnapshotId || baseline.publicationSequence !== status.baselineSequence) return { kind: "unavailable" };
  return { kind: "compared", semantic: JSON.stringify(agreedProjection(saved.document)) !== JSON.stringify(agreedProjection(baseline.snapshot.documentJson)),
    layout: JSON.stringify(layoutMeaning(saved.layout)) !== JSON.stringify(layoutMeaning(baseline.snapshot.layoutJson)) };
}
