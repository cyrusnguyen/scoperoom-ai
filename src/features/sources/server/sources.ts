import { randomUUID } from "node:crypto";
import { evidenceStats } from "../../proposals/domain/capture.ts";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import {
  checkReceipt, findReceipt, lockActor, lockProject, profileFor, readAsMember, recordEvent, requestHash, requireActive, requireMember, saveReceipt,
  withDatabase, type ProjectRow, type Transaction,
} from "../../projects/server/access.ts";
import { draftMutation } from "../../drafts/server/execute-command.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import {
  parseCorrectSource, parseCreateSource, parseGraphSource, parseSourceWriteResult, parseUpdateSource, SOURCE_LIMITS, SOURCE_PAGE_SIZE, USER_DOCUMENT_LIMIT, USER_SOURCE_KINDS,
  type SourceHead, type SourceKind, type SourcePage, type SourceVersionPage, type SourceWriteResult,
} from "../contracts/source-version.ts";
import { graphExtract } from "../domain/graph-extract.ts";
import { assertSourceCapacity, insertSource } from "./source-versions.ts";

type Write = SourceWriteResult & { replayed: boolean };

/** Normalized, measured evidence; an over-long submission is a capacity refusal that keeps the person's text. */
export function measured(raw: string) {
  const evidence = evidenceStats(raw);
  // Normalization removes exactly one leading BOM; a second one would fail the stored-text CHECK, so it is a clear input refusal.
  if (evidence.codePointCount === 0 || evidence.text.startsWith("\uFEFF")) throw new ProjectError("INVALID_INPUT");
  if (evidence.codePointCount > SOURCE_LIMITS.submissionCodePoints) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_SUBMISSION" });
  return evidence;
}

/** Project-scoped source write in the Data03 order: actor → project lock → access → receipt → editor → ACTIVE → work. */
async function sourceMutation(identity: ProjectIdentity, projectId: string, key: unknown, operation: string, input: unknown,
  work: (tx: Transaction, project: ProjectRow, actorId: string) => Promise<SourceWriteResult>): Promise<Write> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  if (typeof key !== "string" || !keyPattern.test(key)) throw new ProjectError("INVALID_INPUT");
  const hash = requestHash(operation, input);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) {
        checkReceipt(receipt, operation, hash);
        const stored = parseSourceWriteResult(receipt.result);
        const [exists] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM app.source_document WHERE id = ${stored.sourceId}::uuid AND project_id = ${project.id}::uuid`;
        if (!exists) throw new ProjectError("NOT_FOUND");
        return { ...stored, replayed: true };
      }
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      const value = await work(tx, project, profile.id);
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, operation, hash, value);
      return { ...value, replayed: false };
    }, { timeout: 15_000 });
  });
}

/** One audit event; the project's sources cursor and the source's own cursor take its sequence. */
export async function advanceSources(tx: Transaction, project: ProjectRow, actorId: string, action: string, sourceId: string): Promise<bigint> {
  const sequence = await recordEvent(tx, project, actorId, action, [{ kind: "SOURCE", id: sourceId }], {});
  await tx.$executeRaw`UPDATE app.project SET sources_revision = ${sequence}::bigint WHERE id = ${project.id}::uuid`;
  await tx.$executeRaw`UPDATE app.source_document SET last_event_sequence = ${sequence}::bigint WHERE id = ${sourceId}::uuid`;
  return sequence;
}

export async function assertUserDocumentSlot(tx: Transaction, projectId: string) {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::integer AS n FROM app.source_document
    WHERE project_id = ${projectId}::uuid AND NOT archived AND kind::text = ANY(${[...USER_SOURCE_KINDS]}::text[])`;
  if ((row?.n ?? 0) >= USER_DOCUMENT_LIMIT) throw new ProjectError("LIMIT_EXCEEDED", { limit: "SOURCE_DOCUMENTS" });
}

const written = (sourceId: string, versionId: string, version: number, sequence: number, sourcesRevision: bigint, eventSequence = sourcesRevision): SourceWriteResult =>
  ({ sourceId, sourceVersionId: versionId, version, sequence, sourcesRevision: Number(sourcesRevision), eventSequence: Number(eventSequence) });

export async function createSource(identity: ProjectIdentity, projectId: string, input: Record<string, unknown>): Promise<Write> {
  projectId = projectId.toLowerCase(); // ids are case-insensitive on the wire; receipts and hashes use one spelling
  const { key, ...raw } = input;
  let parsed: ReturnType<typeof parseCreateSource>;
  try { parsed = parseCreateSource(raw); } catch { throw new ProjectError("INVALID_INPUT"); }
  const evidence = measured(parsed.text);
  return sourceMutation(identity, projectId, key, "CREATE_SOURCE_V1", { projectId, ...parsed }, async (tx, project, actorId) => {
    await assertUserDocumentSlot(tx, project.id);
    await assertSourceCapacity(tx, project.id, evidence.codePointCount);
    const { sourceId, versionId } = await insertSource(tx, project.id, actorId, parsed.uploaded ? "USER_UPLOAD" : "USER_TEXT", parsed.title, evidence);
    return written(sourceId, versionId, 1, 1, await advanceSources(tx, project, actorId, "SOURCE_CREATED", sourceId));
  });
}

/** POST D/graph-sources: the exact saved flow at an inspected revision, never unsaved canvas state. */
export async function createGraphSource(identity: ProjectIdentity, projectId: string, draftId: string, input: Record<string, unknown>): Promise<Write> {
  projectId = projectId.toLowerCase(); draftId = draftId.toLowerCase();
  const { key, ...raw } = input;
  let parsed: ReturnType<typeof parseGraphSource>;
  try {
    if (typeof key !== "string" || !keyPattern.test(key)) throw new Error("INVALID_INPUT");
    parsed = parseGraphSource(raw);
  } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "CREATE_GRAPH_SOURCE_V1";
  return draftMutation(identity, projectId, draftId, key, operation, requestHash(operation, { projectId, draftId, ...parsed }), parseSourceWriteResult, async (tx, project, draft, actorId) => {
    if (draft.documentRevision !== parsed.expectedDocumentRevision) throw new ProjectError("STALE_DOCUMENT_REVISION", { documentRevision: draft.documentRevision });
    if (!draft.draft.document.flows[parsed.flowId]) throw new ProjectError("INVALID_INPUT");
    const extract = graphExtract(draft.draft.document, parsed.flowId);
    const evidence = measured(extract.text);
    await assertUserDocumentSlot(tx, project.id);
    await assertSourceCapacity(tx, project.id, evidence.codePointCount);
    // The draft row is overwritten in place, so the selected ids are stored here rather than derived from the revision later.
    const origin = { type: "GRAPH", draftId: draft.id, documentRevision: draft.documentRevision, flowId: parsed.flowId, nodeIds: extract.nodeIds, edgeIds: extract.edgeIds, copiedTextHash: evidence.contentHash, promotedBy: actorId };
    const { sourceId, versionId } = await insertSource(tx, project.id, actorId, "PROMOTED_GRAPH", parsed.title, evidence, { draftId: draft.id, value: origin });
    return written(sourceId, versionId, 1, 1, await advanceSources(tx, project, actorId, "SOURCE_CREATED", sourceId));
  });
}

/** Lock order 5 (source document): the user-managed source being changed. Internal evidence is read-only. */
async function lockUserSource(tx: Transaction, projectId: string, sourceId: string, expectedVersion: number) {
  if (!uuid.test(sourceId)) throw new ProjectError("NOT_FOUND");
  const [row] = await tx.$queryRaw<Array<{ kind: SourceKind; version: number; archived: boolean; current_version_id: string; display_nickname: string | null; sequence: number }>>`
    SELECT source.kind::text AS kind, source.version, source.archived, source.current_version_id, source.display_nickname, head.sequence
    FROM app.source_document source JOIN app.source_version head ON head.id = source.current_version_id
    WHERE source.id = ${sourceId}::uuid AND source.project_id = ${projectId}::uuid FOR UPDATE OF source`;
  if (!row) throw new ProjectError("NOT_FOUND");
  if (!USER_SOURCE_KINDS.includes(row.kind)) throw new ProjectError("FORBIDDEN");
  if (row.version !== expectedVersion) throw new ProjectError("STALE_ENTITY_VERSION", { entityId: sourceId, currentVersion: row.version });
  return row;
}

export async function correctSource(identity: ProjectIdentity, projectId: string, sourceId: string, input: Record<string, unknown>): Promise<Write> {
  projectId = projectId.toLowerCase(); sourceId = sourceId.toLowerCase();
  const { key, ...raw } = input;
  let parsed: ReturnType<typeof parseCorrectSource>;
  try { parsed = parseCorrectSource(raw); } catch { throw new ProjectError("INVALID_INPUT"); }
  const evidence = measured(parsed.text);
  return sourceMutation(identity, projectId, key, "CORRECT_SOURCE_V1", { projectId, sourceId, ...parsed }, async (tx, project, actorId) => {
    const source = await lockUserSource(tx, project.id, sourceId, parsed.expectedSourceRecordVersion);
    if (source.current_version_id !== parsed.expectedCurrentVersionId) throw new ProjectError("STALE_ENTITY_VERSION", { entityId: sourceId, currentVersion: source.version });
    if (source.archived) throw new ProjectError("CONFLICT");
    await assertSourceCapacity(tx, project.id, evidence.codePointCount);
    const versionId = randomUUID(), sequence = source.sequence + 1, version = source.version + 1;
    await tx.$executeRaw`
      INSERT INTO app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
      VALUES (${versionId}::uuid, ${project.id}::uuid, ${sourceId}::uuid, ${sequence}, ${parsed.title}, ${evidence.text}, ${evidence.codePointCount}, ${evidence.utf8ByteCount}, ${evidence.contentHash}, ${actorId}::uuid)`;
    await tx.$executeRaw`UPDATE app.source_document SET current_version_id = ${versionId}::uuid, version = ${version}, updated_at = CURRENT_TIMESTAMP WHERE id = ${sourceId}::uuid`;
    return written(sourceId, versionId, version, sequence, await advanceSources(tx, project, actorId, "SOURCE_CORRECTED", sourceId));
  });
}

export async function updateSource(identity: ProjectIdentity, projectId: string, sourceId: string, input: Record<string, unknown>): Promise<Write> {
  projectId = projectId.toLowerCase(); sourceId = sourceId.toLowerCase();
  const { key, ...raw } = input;
  let parsed: ReturnType<typeof parseUpdateSource>;
  try { parsed = parseUpdateSource(raw); } catch { throw new ProjectError("INVALID_INPUT"); }
  return sourceMutation(identity, projectId, key, "UPDATE_SOURCE_V1", { projectId, sourceId, ...parsed }, async (tx, project, actorId) => {
    const source = await lockUserSource(tx, project.id, sourceId, parsed.expectedSourceRecordVersion);
    const archived = parsed.archived ?? source.archived;
    const nickname = parsed.displayNickname === undefined ? source.display_nickname : parsed.displayNickname;
    if (archived === source.archived && nickname === source.display_nickname) {
      return written(sourceId, source.current_version_id, source.version, source.sequence, BigInt(project.sourcesRevision), project.eventSequence);
    }
    if (source.archived && !archived) await assertUserDocumentSlot(tx, project.id);
    const version = source.version + 1;
    await tx.$executeRaw`UPDATE app.source_document SET archived = ${archived}, display_nickname = ${nickname}, version = ${version}, updated_at = CURRENT_TIMESTAMP WHERE id = ${sourceId}::uuid`;
    return written(sourceId, source.current_version_id, version, source.sequence, await advanceSources(tx, project, actorId, archived !== source.archived ? (archived ? "SOURCE_ARCHIVED" : "SOURCE_RESTORED") : "SOURCE_RENAMED", sourceId));
  });
}

const SCOPES = { user: { archived: false, kinds: USER_SOURCE_KINDS }, archived: { archived: true, kinds: USER_SOURCE_KINDS }, internal: { archived: null, kinds: ["QUESTION_ANSWER", "AI_PROMPT"] } } as const;

/** The current head is independent of a list filter or page, including after archive and panel remounts. */
export async function readSource(identity: ProjectIdentity, projectId: string, sourceId: string): Promise<SourceHead> {
  if (!uuid.test(projectId) || !uuid.test(sourceId)) throw new ProjectError("NOT_FOUND");
  return readAsMember(identity, projectId.toLowerCase(), async (tx, project) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; kind: SourceKind; title: string; display_nickname: string | null; archived: boolean; version: number; current_version_id: string; sequence: number; version_count: number; created_by: string; created_at: Date }>>`
      SELECT source.id, source.kind::text AS kind, head.title, source.display_nickname, source.archived, source.version, source.current_version_id, head.sequence,
        (SELECT count(*)::integer FROM app.source_version v WHERE v.source_id = source.id) AS version_count, source.created_by, source.created_at
      FROM app.source_document source JOIN app.source_version head ON head.id = source.current_version_id
      WHERE source.project_id = ${project.id}::uuid AND source.id = ${sourceId}::uuid`;
    if (!row) throw new ProjectError("NOT_FOUND");
    return { id: row.id, kind: row.kind, title: row.title, displayNickname: row.display_nickname, archived: row.archived, version: row.version,
      currentVersionId: row.current_version_id, currentSequence: row.sequence, versionCount: row.version_count, createdBy: row.created_by, createdAt: row.created_at.toISOString() };
  });
}

/** Paginated source heads (newest first) plus project-wide usage, for any reader. Never loads bodies. */
export async function listSources(identity: ProjectIdentity, projectId: string, query: { scope?: string; cursor?: string }): Promise<SourcePage> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase();
  const name = query.scope ?? "user";
  if (!Object.hasOwn(SCOPES, name) || (query.cursor !== undefined && !uuid.test(query.cursor))) throw new ProjectError("INVALID_INPUT");
  const scope = SCOPES[name as keyof typeof SCOPES];
  return readAsMember(identity, projectId, async (tx, project) => {
    const rows = await tx.$queryRaw<Array<{ id: string; kind: SourceKind; title: string; display_nickname: string | null; archived: boolean; version: number; current_version_id: string; sequence: number; version_count: number; created_by: string; created_at: Date }>>`
      SELECT source.id, source.kind::text AS kind, head.title, source.display_nickname, source.archived, source.version, source.current_version_id, head.sequence,
        (SELECT count(*)::integer FROM app.source_version v WHERE v.source_id = source.id) AS version_count, source.created_by, source.created_at
      FROM app.source_document source JOIN app.source_version head ON head.id = source.current_version_id
      WHERE source.project_id = ${project.id}::uuid AND source.kind::text = ANY(${[...scope.kinds]}::text[])
        AND (${scope.archived}::boolean IS NULL OR source.archived = ${scope.archived}::boolean)
        AND (${query.cursor ?? null}::uuid IS NULL OR (source.created_at, source.id) < (SELECT created_at, id FROM app.source_document WHERE id = ${query.cursor ?? null}::uuid AND project_id = ${project.id}::uuid))
      ORDER BY source.created_at DESC, source.id DESC LIMIT ${SOURCE_PAGE_SIZE + 1}`;
    const [usage] = await tx.$queryRaw<Array<{ active: number; versions: number; code_points: number }>>`
      SELECT (SELECT count(*)::integer FROM app.source_document WHERE project_id = ${project.id}::uuid AND NOT archived AND kind::text = ANY(${[...USER_SOURCE_KINDS]}::text[])) AS active,
        count(*)::integer AS versions, COALESCE(sum(code_point_count), 0)::integer AS code_points
      FROM app.source_version WHERE project_id = ${project.id}::uuid`;
    const items: SourceHead[] = rows.slice(0, SOURCE_PAGE_SIZE).map((row) => ({
      id: row.id, kind: row.kind, title: row.title, displayNickname: row.display_nickname, archived: row.archived, version: row.version,
      currentVersionId: row.current_version_id, currentSequence: row.sequence, versionCount: row.version_count, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
    }));
    return {
      items, nextCursor: rows.length > SOURCE_PAGE_SIZE ? items.at(-1)!.id : null, sourcesRevision: project.sourcesRevision,
      usage: { activeUserDocuments: usage?.active ?? 0, retainedVersions: usage?.versions ?? 0, codePoints: usage?.code_points ?? 0 },
    };
  });
}

export async function listSourceVersions(identity: ProjectIdentity, projectId: string, sourceId: string, cursor?: string): Promise<SourceVersionPage> {
  if (!uuid.test(projectId) || !uuid.test(sourceId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase(); sourceId = sourceId.toLowerCase();
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1 || before > 2147483647)) throw new ProjectError("INVALID_INPUT");
  return readAsMember(identity, projectId, async (tx, project) => {
    const rows = await tx.$queryRaw<Array<{ id: string; sequence: number; title: string; content_hash: string; code_point_count: number; created_by: string; created_at: Date }>>`
      SELECT version.id, version.sequence, version.title, version.content_hash, version.code_point_count, version.created_by, version.created_at
      FROM app.source_version version
      WHERE version.project_id = ${project.id}::uuid AND version.source_id = ${sourceId}::uuid AND (${before}::integer IS NULL OR version.sequence < ${before}::integer)
      ORDER BY version.sequence DESC LIMIT ${SOURCE_PAGE_SIZE + 1}`;
    if (!rows.length && before === null) throw new ProjectError("NOT_FOUND");
    const items = rows.slice(0, SOURCE_PAGE_SIZE).map((row) => ({ id: row.id, sequence: row.sequence, title: row.title, contentHash: row.content_hash, codePointCount: row.code_point_count, createdBy: row.created_by, createdAt: row.created_at.toISOString() }));
    return { items, nextCursor: rows.length > SOURCE_PAGE_SIZE ? items.at(-1)!.sequence : null };
  });
}
