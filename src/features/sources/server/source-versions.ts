import { randomUUID } from "node:crypto";
import { ProjectError } from "../../projects/server/errors.ts";
import type { Transaction } from "../../projects/server/access.ts";
import { SOURCE_LIMITS } from "../contracts/source-version.ts";

/** Normalized evidence measures (see `evidenceStats`); the database recomputes and rejects any disagreement. */
export type PromptEvidence = { text: string; codePointCount: number; utf8ByteCount: number; contentHash: string };

/** Under the project lock: every retained version, archived and internal prompts included, counts against project capacity. */
export async function assertSourceCapacity(tx: Transaction, projectId: string, addedCodePoints: number) {
  const [usage] = await tx.$queryRaw<Array<{ versions: number; code_points: number }>>`
    SELECT count(*)::integer AS versions, COALESCE(sum(code_point_count), 0)::integer AS code_points FROM app.source_version WHERE project_id = ${projectId}::uuid`;
  if (!usage) throw new ProjectError("UNAVAILABLE");
  if (usage.versions + 1 > SOURCE_LIMITS.retainedVersions) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_VERSIONS" });
  if (usage.code_points + addedCodePoints > SOURCE_LIMITS.projectCodePoints) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_CODE_POINTS" });
}

/** The immutable AI_PROMPT source and its first (head) version. The head key is deferred, so both rows are written ids-first in one transaction. */
export async function insertPromptEvidence(tx: Transaction, projectId: string, actorId: string, evidence: PromptEvidence): Promise<string> {
  const sourceId = randomUUID();
  const versionId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO app.source_document (id, project_id, kind, current_version_id, created_by)
    VALUES (${sourceId}::uuid, ${projectId}::uuid, 'AI_PROMPT'::app.source_kind, ${versionId}::uuid, ${actorId}::uuid)`;
  await tx.$executeRaw`
    INSERT INTO app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
    VALUES (${versionId}::uuid, ${projectId}::uuid, ${sourceId}::uuid, 1, 'AI instruction', ${evidence.text}, ${evidence.codePointCount}, ${evidence.utf8ByteCount}, ${evidence.contentHash}, ${actorId}::uuid)`;
  return versionId;
}
