import { checkDraft } from "../../drafts/domain/graph.ts";
import { asJson, graphFailure, nextRevision, storedDraft } from "../../drafts/server/execute-command.ts";
import type { ProjectRow, Transaction } from "../../projects/server/access.ts";
import { unassignMember } from "../domain/scope.ts";

/** Called after membership and invitation locks (lock order: membership -> invitation -> draft). */
export async function unassignInCurrentDraft(tx: Transaction, project: ProjectRow, profileId: string): Promise<number> {
  if (!project.currentDraftId) return 0;
  const [row] = await tx.$queryRaw<Array<{ document_revision: number; document_json: unknown; layout_json: unknown }>>`
    SELECT document_revision, document_json, layout_json FROM app.scope_draft
    WHERE id = ${project.currentDraftId}::uuid AND project_id = ${project.id}::uuid AND status = 'EDITABLE' FOR UPDATE`;
  if (!row) return 0;
  const draft = storedDraft(row.document_json, row.layout_json);
  let document: typeof draft.document, changedIds: string[];
  try { ({ document, changedIds } = unassignMember(draft.document, profileId)); } catch (error) { graphFailure(error); }
  if (!changedIds.length) return 0;
  checkDraft({ document, layout: draft.layout });
  await tx.scopeDraft.update({ where: { id: project.currentDraftId }, data: { documentJson: asJson(document), documentRevision: nextRevision(row.document_revision) }, select: { id: true } });
  return changedIds.length;
}
