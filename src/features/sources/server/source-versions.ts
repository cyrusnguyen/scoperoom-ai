import { randomUUID } from "node:crypto";
import type { SourceRef } from "../../drafts/contracts/scope-document.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { readAsMember, type Transaction } from "../../projects/server/access.ts";
import { citationMatches, lineStarts, SOURCE_LIMITS, type SourceKind, type SourceVersionView } from "../contracts/source-version.ts";

/** Normalized evidence measures (see `evidenceStats`); the database recomputes and rejects any disagreement. */
export type PromptEvidence = { text: string; codePointCount: number; utf8ByteCount: number; contentHash: string };

/** Every citation names an immutable version of this project and quotes its own line range exactly (SCP-002, SCP-003). */
export async function checkSourceRefs(tx: Transaction, projectId: string, refs: SourceRef[]) {
  if (!refs.length) return;
  const versionIds = [...new Set(refs.map((ref) => ref.sourceVersionId))];
  const rows = await tx.$queryRaw<Array<{ id: string; text: string }>>`
    SELECT id, text FROM app.source_version WHERE project_id = ${projectId}::uuid AND id = ANY(${versionIds}::uuid[])`;
  const texts = new Map(rows.map((row) => [row.id, row.text]));
  for (const ref of refs) {
    const text = texts.get(ref.sourceVersionId);
    if (text === undefined || !citationMatches(text, ref)) throw new ProjectError("INVALID_SOURCE_REFERENCE");
  }
}

/** Under the project lock: every retained version, archived and internal prompts included, counts against project capacity. */
export async function assertSourceCapacity(tx: Transaction, projectId: string, addedCodePoints: number) {
  const [usage] = await tx.$queryRaw<Array<{ versions: number; code_points: number }>>`
    SELECT count(*)::integer AS versions, COALESCE(sum(code_point_count), 0)::integer AS code_points FROM app.source_version WHERE project_id = ${projectId}::uuid`;
  if (!usage) throw new ProjectError("UNAVAILABLE");
  if (usage.versions + 1 > SOURCE_LIMITS.retainedVersions) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_VERSIONS" });
  if (usage.code_points + addedCodePoints > SOURCE_LIMITS.projectCodePoints) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_CODE_POINTS" });
}

/** A new immutable source and its first (head) version. The head key is deferred, so both rows are written ids-first in one transaction. */
export async function insertSource(
  tx: Transaction, projectId: string, actorId: string, kind: SourceKind, title: string, evidence: PromptEvidence,
  origin: { draftId: string; value: Record<string, unknown> } | null = null,
): Promise<{ sourceId: string; versionId: string }> {
  const sourceId = randomUUID();
  const versionId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO app.source_document (id, project_id, kind, current_version_id, created_by)
    VALUES (${sourceId}::uuid, ${projectId}::uuid, ${kind}::app.source_kind, ${versionId}::uuid, ${actorId}::uuid)`;
  await tx.$executeRaw`
    INSERT INTO app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by, origin, origin_draft_id)
    VALUES (${versionId}::uuid, ${projectId}::uuid, ${sourceId}::uuid, 1, ${title}, ${evidence.text}, ${evidence.codePointCount}, ${evidence.utf8ByteCount}, ${evidence.contentHash}, ${actorId}::uuid,
      ${origin === null ? null : JSON.stringify(origin.value)}::jsonb, ${origin?.draftId ?? null}::uuid)`;
  return { sourceId, versionId };
}

/** The immutable AI_PROMPT source of one run. */
export async function insertPromptEvidence(tx: Transaction, projectId: string, actorId: string, evidence: PromptEvidence): Promise<string> {
  return (await insertSource(tx, projectId, actorId, "AI_PROMPT", "AI instruction", evidence)).versionId;
}

/** The one immutable version asked for, inside this exact project and for any current reader. Never the document's current head. */
export async function readSourceVersion(identity: ProjectIdentity, projectId: string, sourceVersionId: string): Promise<SourceVersionView> {
  if (!uuid.test(sourceVersionId)) throw new ProjectError("NOT_FOUND");
  return readAsMember(identity, projectId, async (tx, project) => {
    const [row] = await tx.$queryRaw<Array<{
      id: string; source_id: string; kind: string; sequence: number; title: string; text: string; content_hash: string; code_point_count: number; utf8_byte_count: number;
      origin: unknown; created_by: string; created_at: Date;
    }>>`
      SELECT version.id, version.source_id, source.kind::text AS kind, version.sequence, version.title, version.text, version.content_hash, version.code_point_count,
        version.utf8_byte_count, version.origin, version.created_by, version.created_at
      FROM app.source_version version JOIN app.source_document source ON source.project_id = version.project_id AND source.id = version.source_id
      WHERE version.id = ${sourceVersionId}::uuid AND version.project_id = ${project.id}::uuid`;
    if (!row) throw new ProjectError("NOT_FOUND");
    return {
      id: row.id, sourceId: row.source_id, kind: row.kind, sequence: row.sequence, title: row.title, text: row.text, contentHash: row.content_hash, codePointCount: row.code_point_count,
      utf8ByteCount: row.utf8_byte_count, lineStarts: lineStarts(row.text), origin: row.origin, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
    };
  });
}
