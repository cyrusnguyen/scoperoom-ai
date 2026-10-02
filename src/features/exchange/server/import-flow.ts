import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../../../prisma/generated/client.ts";
import { arrange } from "../../drafts/server/layout.ts";
import { asJson, graphFailure, nextRevision, requireStoredSize, storedDraft } from "../../drafts/server/execute-command.ts";
import { LIMITS, type ScopeDocument } from "../../drafts/contracts/scope-document.ts";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { checkReceipt, findReceipt, lockActor, lockProject, profileFor, readProject, receiptString, recordEvent, requestHash, requireActive, requireMember, saveReceipt, withDatabase, withReadSnapshot, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import type { FlowFileV1 } from "../contracts/flow-file.ts";
import { FLOW_IMPORT_PREVIEW_LIMITS, type ImportApplyInput, type ImportApplyResult, type ImportFidelityReport, type ImportPreviewView } from "../contracts/import.ts";
import { appendImportedFlow } from "../domain/import-flow.ts";
import { parseFlowFile, parseStoredFlowFile } from "../domain/flow-file.ts";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const PREVIEW_OPERATION = "FLOW_IMPORT_PREVIEW_V1";
const DISCARD_OPERATION = "FLOW_IMPORT_DISCARD_V1";
const APPLY_OPERATION = "FLOW_IMPORT_APPLY_V1";
const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;

type StoredPreview = {
  id: string; projectId: string; draftId: string; actorId: string; expectedDocumentRevision: number; state: "READY" | "DISCARDED" | "EXPIRED" | "APPLIED";
  payload: Prisma.JsonValue | null; positions: Prisma.JsonValue | null; fidelityReport: Prisma.JsonValue | null; payloadHash: string; previewHash: string; expiresAt: Date;
  appliedAt: Date | null; resultFlowId: string | null; appliedMapping: Prisma.JsonValue | null; appliedResult: Prisma.JsonValue | null;
};

function stableId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalized(file: FlowFileV1): FlowFileV1 {
  const origin = file.origin.kind === "DRAFT"
    ? { kind: "DRAFT" as const, documentRevision: file.origin.documentRevision, layoutRevision: file.origin.layoutRevision }
    : { kind: "SNAPSHOT" as const, documentRevision: file.origin.documentRevision, layoutRevision: file.origin.layoutRevision, sourceInclusion: file.origin.sourceInclusion,
      ...(file.origin.snapshotId ? { snapshotId: file.origin.snapshotId } : {}), ...(file.origin.contentHash ? { contentHash: file.origin.contentHash } : {}), ...(file.origin.reviewHash ? { reviewHash: file.origin.reviewHash } : {}) };
  return {
    format: "scoperoom-flow", formatVersion: 1, exportedAt: file.exportedAt, producerVersion: file.producerVersion,
    flow: { title: file.flow.title, purpose: file.flow.purpose, classification: file.flow.classification, direction: file.flow.direction },
    nodes: [...file.nodes].sort((a, b) => compare(a.id, b.id)).map((node) => ({ id: node.id, kind: node.kind, label: node.label, description: node.description, actorLabel: node.actorLabel, assumptionNotes: [...node.assumptionNotes] })),
    edges: [...file.edges].sort((a, b) => compare(a.id, b.id)).map((edge) => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, condition: edge.condition })), origin,
    ...(file.edgeSides ? { edgeSides: [...file.edgeSides].sort((a, b) => compare(a.edgeId, b.edgeId)).map((side) => ({ edgeId: side.edgeId, from: side.from, to: side.to })) } : {}),
    ...(file.viewport ? { viewport: { x: file.viewport.x, y: file.viewport.y, zoom: file.viewport.zoom } } : {}),
    ...(file.linkHints ? { linkHints: [...file.linkHints].sort((a, b) => compare(`${a.nodeId}\u0000${a.requirementId}`, `${b.nodeId}\u0000${b.requirementId}`)).map((hint) => ({ nodeId: hint.nodeId, requirementId: hint.requirementId, requirementTitle: hint.requirementTitle })) } : {}),
  };
}

function automaticPositions(file: FlowFileV1): NonNullable<FlowFileV1["positions"]> {
  const flowId = stableId("flow-import:flow");
  const nodeIds = new Map(file.nodes.map((node) => [node.id, stableId(`flow-import:node:${node.id}`)]));
  const document: ScopeDocument = {
    schemaVersion: 3, projectGoal: "", retiredEntityIds: [], requirements: {}, traceLinks: {}, scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {},
    flows: { [flowId]: { id: flowId, version: 1, behaviourVersion: 1, title: file.flow.title, purpose: file.flow.purpose, classification: file.flow.classification, inclusion: "UNDECIDED", confirmation: null, verificationMethod: null } },
    nodes: Object.fromEntries(file.nodes.map((node) => {
      const id = nodeIds.get(node.id)!;
      return [id, { id, flowId, version: 1, behaviourVersion: 1, kind: node.kind, label: node.label, description: node.description, actorLabel: node.actorLabel ?? "", origin: "IMPORTED", sourceRefs: [], assumptionNotes: node.assumptionNotes }];
    })),
    edges: Object.fromEntries(file.edges.map((edge) => {
      const id = stableId(`flow-import:edge:${edge.id}`);
      return [id, { id, flowId, version: 1, fromId: nodeIds.get(edge.fromId)!, toId: nodeIds.get(edge.toId)!, condition: edge.condition ?? "", origin: "IMPORTED", sourceRefs: [] }];
    })),
  };
  const laidOut = arrange(document, flowId, file.flow.direction);
  return file.nodes.map((node) => ({ nodeId: node.id, ...laidOut[nodeIds.get(node.id)!]! }));
}

function parsedUpload(file: FlowFileV1) {
  const source = normalized(file);
  const suppliedPositions = file.positions ? [...file.positions].sort((a, b) => compare(a.nodeId, b.nodeId)).map((position) => ({ nodeId: position.nodeId, x: position.x, y: position.y })) : undefined;
  const payloadHash = requestHash("FLOW_IMPORT_PAYLOAD_V1", { ...source, ...(suppliedPositions ? { positions: suppliedPositions } : {}) });
  return { source, suppliedPositions, payloadHash };
}

function asFile(value: Prisma.JsonValue | null): FlowFileV1 | null {
  if (value === null) return null;
  try { return parseFlowFile(new TextEncoder().encode(JSON.stringify(value))); } catch { throw new ProjectError("UNAVAILABLE"); }
}

function asReport(value: Prisma.JsonValue | null): ImportFidelityReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value === null ? null : (() => { throw new ProjectError("UNAVAILABLE"); })();
  const report = value as Record<string, unknown>;
  if (typeof report.nodeCount !== "number" || typeof report.edgeCount !== "number" || typeof report.omittedLinkHintCount !== "number" || (report.geometry !== "SUPPLIED" && report.geometry !== "AUTOMATIC")) throw new ProjectError("UNAVAILABLE");
  return report as ImportFidelityReport;
}

function asPositions(value: Prisma.JsonValue | null): NonNullable<FlowFileV1["positions"]> | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((position) => !position || typeof position !== "object" || Array.isArray(position))) throw new ProjectError("UNAVAILABLE");
  return value as NonNullable<FlowFileV1["positions"]>;
}

function viewOf(preview: StoredPreview, now: Date): ImportPreviewView {
  const state = preview.state === "READY" && preview.expiresAt <= now ? "EXPIRED" : preview.state;
  const body = state === "READY" || state === "DISCARDED";
  return { id: preview.id, projectId: preview.projectId, draftId: preview.draftId, previewHash: preview.previewHash, expiresAt: preview.expiresAt.toISOString(), expectedDocumentRevision: preview.expectedDocumentRevision,
    state, file: body ? asFile(preview.payload) : null, positions: body ? asPositions(preview.positions) : null, fidelityReport: body ? asReport(preview.fidelityReport) : null, result: appliedResult(preview) };
}

function appliedResult(preview: StoredPreview): ImportApplyResult | null {
  if (preview.state !== "APPLIED") return null;
  const result = preview.appliedResult;
  const mapping = preview.appliedMapping;
  if (!result || typeof result !== "object" || Array.isArray(result) || !mapping || typeof mapping !== "object" || Array.isArray(mapping)
    || result.previewId !== preview.id || result.draftId !== preview.draftId || result.flowId !== preview.resultFlowId || mapping.flowId !== preview.resultFlowId
    || ![result.documentRevision, result.layoutRevision, result.eventSequence].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) throw new ProjectError("UNAVAILABLE");
  return { ...result, mapping } as ImportApplyResult;
}

/** Re-parse both persisted JSON values before their IDs can enter the append transform. */
function storedImport(preview: StoredPreview): { file: FlowFileV1; positions: NonNullable<FlowFileV1["positions"]> } {
  if (!preview.payload || !preview.positions) throw new ProjectError("UNAVAILABLE");
  try {
    const file = parseStoredFlowFile({ ...(preview.payload as object), positions: preview.positions });
    if (!file.positions) throw new Error("Missing positions");
    return { file, positions: file.positions };
  } catch { throw new ProjectError("UNAVAILABLE"); }
}

async function requireStoredApplySize(tx: Transaction, mapping: ImportApplyResult["mapping"], result: Omit<ImportApplyResult, "mapping">) {
  const receipt = { ...result, mapping };
  const [size] = await tx.$queryRaw<Array<{ mappingBytes: number; resultBytes: number; receiptBytes: number }>>`
    SELECT octet_length(${JSON.stringify(mapping)}::jsonb::text)::integer AS "mappingBytes",
      octet_length(${JSON.stringify(result)}::jsonb::text)::integer AS "resultBytes",
      octet_length(${JSON.stringify(receipt)}::jsonb::text)::integer AS "receiptBytes"`;
  if (!size || size.mappingBytes > 65_536 || size.resultBytes > 65_536 || size.receiptBytes > 65_536) throw new ProjectError("LIMIT_EXCEEDED");
}

function parseApplyInput(input: ImportApplyInput): ImportApplyInput {
  const value = input as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectError("INVALID_INPUT");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !Object.hasOwn(record, "key") || !Object.hasOwn(record, "draftId") || !Object.hasOwn(record, "previewHash")
    || typeof record.key !== "string" || typeof record.draftId !== "string" || typeof record.previewHash !== "string" || !keyPattern.test(record.key)
    || !uuid.test(record.draftId) || !/^[0-9a-f]{64}$/.test(record.previewHash)) throw new ProjectError("INVALID_INPUT");
  return { key: record.key, draftId: record.draftId.toLowerCase(), previewHash: record.previewHash };
}

async function lockImportPreview(tx: Transaction, projectId: string, previewId: string, actorId: string) {
  await tx.$queryRaw`SELECT id FROM app.flow_import_preview
    WHERE id = ${previewId}::uuid AND project_id = ${projectId}::uuid AND actor_id = ${actorId}::uuid FOR UPDATE`;
  const preview = await tx.flowImportPreview.findFirst({ where: { id: previewId, projectId, actorId } }) as StoredPreview | null;
  if (!preview) throw new ProjectError("NOT_FOUND");
  return preview;
}

async function clock(tx: Transaction) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row) throw new ProjectError("UNAVAILABLE");
  return row.now;
}

/** The actor and project locks serialize these cumulative quotas across all projects and actors. */
async function preflightPreviewAdmission(tx: Transaction, actorId: string, projectId: string) {
  const [admission] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT count(*) FILTER (WHERE actor_id = ${actorId}::uuid) < ${FLOW_IMPORT_PREVIEW_LIMITS.actor.rows}
      AND count(*) FILTER (WHERE project_id = ${projectId}::uuid) < ${FLOW_IMPORT_PREVIEW_LIMITS.project.rows}
      AND count(*) FILTER (WHERE actor_id = ${actorId}::uuid AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour') < ${FLOW_IMPORT_PREVIEW_LIMITS.actor.creationsPerHour}
      AND count(*) FILTER (WHERE project_id = ${projectId}::uuid AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour') < ${FLOW_IMPORT_PREVIEW_LIMITS.project.creationsPerHour}
      AND count(*) FILTER (WHERE actor_id = ${actorId}::uuid AND payload IS NOT NULL) < ${FLOW_IMPORT_PREVIEW_LIMITS.actor.bodies}
      AND count(*) FILTER (WHERE project_id = ${projectId}::uuid AND payload IS NOT NULL) < ${FLOW_IMPORT_PREVIEW_LIMITS.project.bodies}
      AS allowed
    FROM app.flow_import_preview
    WHERE actor_id = ${actorId}::uuid OR project_id = ${projectId}::uuid`;
  if (!admission?.allowed) throw new ProjectError("LIMIT_EXCEEDED");
}

async function admitPreviewBody(tx: Transaction, actorId: string, projectId: string, source: FlowFileV1, positions: NonNullable<FlowFileV1["positions"]>, fidelityReport: ImportFidelityReport) {
  const [admission] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    WITH candidate AS (
      SELECT octet_length(${JSON.stringify(source)}::jsonb::text) AS payload_bytes,
        octet_length(${JSON.stringify(positions)}::jsonb::text) AS positions_bytes,
        octet_length(${JSON.stringify(fidelityReport)}::jsonb::text) AS report_bytes
    ), usage AS (
      SELECT COALESCE(sum(octet_length(payload::text) + octet_length(positions::text) + octet_length(fidelity_report::text)) FILTER (WHERE actor_id = ${actorId}::uuid AND payload IS NOT NULL), 0) AS actor_bytes,
        COALESCE(sum(octet_length(payload::text) + octet_length(positions::text) + octet_length(fidelity_report::text)) FILTER (WHERE project_id = ${projectId}::uuid AND payload IS NOT NULL), 0) AS project_bytes
      FROM app.flow_import_preview
      WHERE actor_id = ${actorId}::uuid OR project_id = ${projectId}::uuid
    )
    SELECT candidate.payload_bytes <= 1048576 AND candidate.positions_bytes <= 262144 AND candidate.report_bytes <= 65536
      AND usage.actor_bytes + candidate.payload_bytes + candidate.positions_bytes + candidate.report_bytes <= ${FLOW_IMPORT_PREVIEW_LIMITS.actor.bodyBytes}
      AND usage.project_bytes + candidate.payload_bytes + candidate.positions_bytes + candidate.report_bytes <= ${FLOW_IMPORT_PREVIEW_LIMITS.project.bodyBytes}
      AS allowed
    FROM candidate CROSS JOIN usage`;
  if (!admission?.allowed) throw new ProjectError("LIMIT_EXCEEDED");
}

async function lockedTarget(tx: Transaction, projectId: string, draftId: string, currentDraftId: string | null, file: FlowFileV1) {
  const [draft] = await tx.$queryRaw<Array<{ document_revision: number; status: string; document_json: ScopeDocument }>>`
    SELECT document_revision, status::text AS status, document_json FROM app.scope_draft WHERE id = ${draftId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`;
  if (!draft) throw new ProjectError("NOT_FOUND");
  if (draft.status !== "EDITABLE" || draftId !== currentDraftId) throw new ProjectError("DRAFT_REPLACED");
  if (Object.keys(draft.document_json.flows).length >= LIMITS.flows || Object.keys(draft.document_json.nodes).length + file.nodes.length > LIMITS.nodes
    || Object.keys(draft.document_json.edges).length + file.edges.length > LIMITS.edges) throw new ProjectError("LIMIT_EXCEEDED");
  return draft.document_revision;
}

function parseUpload(bytes: Uint8Array) {
  try { return parsedUpload(parseFlowFile(bytes)); } catch (error) {
    if (error instanceof Error && error.cause === "UNSUPPORTED_FLOW_FORMAT") throw new ProjectError("UNSUPPORTED_FLOW_FORMAT");
    throw new ProjectError("INVALID_INPUT");
  }
}

export async function previewFlowImport(identity: ProjectIdentity, projectId: string, draftId: string, previewId: string, key: string, bytes: Uint8Array): Promise<ImportPreviewView> {
  if (!uuid.test(projectId) || !uuid.test(draftId) || !uuid.test(previewId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase();
  draftId = draftId.toLowerCase();
  previewId = previewId.toLowerCase();
  if (!keyPattern.test(key)) throw new ProjectError("INVALID_INPUT");
  const parsed = parseUpload(bytes);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId, true);
      const project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const existing = await tx.flowImportPreview.findUnique({ where: { id: previewId } }) as StoredPreview | null;
      const now = await clock(tx);
      if (existing) {
        if (existing.actorId !== profile.id || existing.projectId !== project.id) throw new ProjectError("NOT_FOUND");
        if (existing.draftId !== draftId || existing.payloadHash !== parsed.payloadHash) throw new ProjectError("KEY_REUSED");
        const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
        if (receipt) {
          checkReceipt(receipt, PREVIEW_OPERATION, existing.previewHash);
          if (receiptString(receipt.result, "previewId") !== previewId) throw new ProjectError("KEY_REUSED");
        }
        return viewOf(existing, now);
      }
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) throw new ProjectError("KEY_REUSED");
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      const expectedDocumentRevision = await lockedTarget(tx, project.id, draftId, project.currentDraftId, parsed.source);
      await preflightPreviewAdmission(tx, profile.id, project.id);
      const positions = parsed.suppliedPositions ?? automaticPositions(parsed.source);
      const fidelityReport: ImportFidelityReport = { nodeCount: parsed.source.nodes.length, edgeCount: parsed.source.edges.length, omittedLinkHintCount: parsed.source.linkHints?.length ?? 0, geometry: parsed.suppliedPositions ? "SUPPLIED" : "AUTOMATIC" };
      const hash = requestHash(PREVIEW_OPERATION, { projectId, draftId, previewId, actorId: profile.id, file: parsed.source, positions, fidelityReport });
      await admitPreviewBody(tx, profile.id, project.id, parsed.source, positions, fidelityReport);
      const preview = await tx.flowImportPreview.create({ data: { id: previewId, projectId: project.id, draftId, actorId: profile.id, expectedDocumentRevision, payload: parsed.source as Prisma.InputJsonValue, positions: positions as Prisma.InputJsonValue, fidelityReport: fidelityReport as Prisma.InputJsonValue, payloadHash: parsed.payloadHash, previewHash: hash, expiresAt: new Date(now.getTime() + PREVIEW_RETENTION_MS) } }) as StoredPreview;
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, PREVIEW_OPERATION, hash, { previewId, previewHash: hash, draftId });
      return viewOf(preview, now);
    });
  });
}

export async function getFlowImport(identity: ProjectIdentity, projectId: string, previewId: string): Promise<ImportPreviewView> {
  if (!uuid.test(projectId) || !uuid.test(previewId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireMember(project);
      const preview = await tx.flowImportPreview.findFirst({ where: { id: previewId, projectId: project.id, actorId: profile.id } }) as StoredPreview | null;
      if (!preview) throw new ProjectError("NOT_FOUND");
      return viewOf(preview, await clock(tx));
    });
  });
}

/**
 * Appends a preview exactly once. It deliberately does not use `draftMutation`: an APPLIED preview is a durable result
 * whose recovery must survive a later draft replacement, role downgrade, archive, and receipt cleanup.
 */
export async function applyFlowImport(identity: ProjectIdentity, projectId: string, previewId: string, rawInput: ImportApplyInput): Promise<ImportApplyResult & { replayed: boolean }> {
  if (!uuid.test(projectId) || !uuid.test(previewId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase();
  previewId = previewId.toLowerCase();
  const input = parseApplyInput(rawInput);
  const hash = requestHash(APPLY_OPERATION, { projectId, previewId, draftId: input.draftId, previewHash: input.previewHash });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      // Lock order is profile, project, preview, then the saved draft. Cleanup only takes the preview lock.
      await lockActor(tx, profile.id, identity.authUserId, true);
      const project = await lockProject(tx, profile.id, projectId);
      requireMember(project);
      const preview = await lockImportPreview(tx, project.id, previewId, profile.id);
      if (preview.draftId !== input.draftId || preview.previewHash !== input.previewHash) throw new ProjectError("IMPORT_PAYLOAD_MISMATCH");

      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, input.key);
      if (receipt) {
        checkReceipt(receipt, APPLY_OPERATION, hash);
        const result = appliedResult(preview);
        if (!result) throw new ProjectError("UNAVAILABLE");
        return { ...result, replayed: true };
      }

      // Terminal recovery is read-only, including after receipt cleanup, downgrade and archive.
      const retained = appliedResult(preview);
      if (retained) return { ...retained, replayed: true };

      const now = await clock(tx);
      if (preview.state === "EXPIRED" || preview.expiresAt <= now) throw new ProjectError("IMPORT_EXPIRED");
      if (preview.state !== "READY") throw new ProjectError("IMPORT_STALE");
      if (project.role !== "OWNER" && project.role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);

      const [stored] = await tx.$queryRaw<Array<{ id: string; status: string; document_revision: number; layout_revision: number; document_json: unknown; layout_json: unknown }>>`
        SELECT id, status::text AS status, document_revision, layout_revision, document_json, layout_json
        FROM app.scope_draft WHERE id = ${preview.draftId}::uuid AND project_id = ${project.id}::uuid FOR UPDATE`;
      if (!stored || stored.id !== project.currentDraftId || stored.status !== "EDITABLE") throw new ProjectError("IMPORT_STALE");
      if (preview.expiresAt <= await clock(tx)) throw new ProjectError("IMPORT_EXPIRED");

      const source = storedImport(preview);
      let appended: ReturnType<typeof appendImportedFlow>;
      try { appended = appendImportedFlow(storedDraft(stored.document_json, stored.layout_json), source.file, source.positions, randomUUID); }
      catch (error) { graphFailure(error); }
      const documentRevision = nextRevision(stored.document_revision);
      const layoutRevision = nextRevision(stored.layout_revision);
      await requireStoredSize(tx, appended!.draft.document, appended!.draft.layout);
      const appliedAt = await clock(tx);
      if (preview.expiresAt <= appliedAt) throw new ProjectError("IMPORT_EXPIRED");
      await tx.scopeDraft.update({ where: { id: stored.id }, data: {
        documentJson: asJson(appended!.draft.document), layoutJson: asJson(appended!.draft.layout), documentRevision, layoutRevision,
      }, select: { id: true } });
      const eventSequence = Number(await recordEvent(tx, project, profile.id, "FLOW_IMPORTED", [
        { kind: "DRAFT", id: stored.id }, { kind: "DRAFT_ENTITY", id: appended!.mapping.flowId },
      ], { draftId: stored.id, flowId: appended!.mapping.flowId, nodeCount: source.file.nodes.length, edgeCount: source.file.edges.length, documentRevision, layoutRevision }));
      const result = { previewId: preview.id, draftId: preview.draftId, flowId: appended!.mapping.flowId, documentRevision, layoutRevision, eventSequence };
      await requireStoredApplySize(tx, appended!.mapping, result);
      const durable = { ...result, mapping: appended!.mapping };
      await tx.flowImportPreview.update({ where: { id: preview.id }, data: {
        state: "APPLIED", appliedAt, resultFlowId: result.flowId, appliedMapping: asJson(appended!.mapping), appliedResult: asJson(result),
      } }).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2039"
          && error.meta?.driverAdapterError instanceof Error && error.meta.driverAdapterError.message === "flow import expired") throw new ProjectError("IMPORT_EXPIRED");
        throw error;
      });
      await saveReceipt(tx, profile.id, "PROJECT", project.id, input.key, APPLY_OPERATION, hash, asJson(durable));
      return { ...durable, replayed: false };
    });
  });
}

export async function discardFlowImport(identity: ProjectIdentity, projectId: string, previewId: string, key: string): Promise<ImportPreviewView> {
  if (!uuid.test(projectId) || !uuid.test(previewId)) throw new ProjectError("NOT_FOUND");
  projectId = projectId.toLowerCase();
  previewId = previewId.toLowerCase();
  if (!keyPattern.test(key)) throw new ProjectError("INVALID_INPUT");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId, true);
      const project = await lockProject(tx, profile.id, projectId);
      const role = requireMember(project);
      // Serialize terminal transitions with cleanup before reading the preview state.
      await tx.$queryRaw`SELECT id FROM app.flow_import_preview
        WHERE id = ${previewId}::uuid AND project_id = ${project.id}::uuid AND actor_id = ${profile.id}::uuid FOR UPDATE`;
      const preview = await tx.flowImportPreview.findFirst({ where: { id: previewId, projectId: project.id, actorId: profile.id } }) as StoredPreview | null;
      if (!preview) throw new ProjectError("NOT_FOUND");
      const now = await clock(tx);
      const hash = requestHash(DISCARD_OPERATION, { projectId, previewId, previewHash: preview.previewHash });
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) { checkReceipt(receipt, DISCARD_OPERATION, hash); return viewOf(preview, now); }
      if (preview.state === "APPLIED") return viewOf(preview, now);
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      if (preview.state !== "READY" || preview.expiresAt <= now) return viewOf(preview, now);
      await tx.flowImportPreview.update({ where: { id: preview.id }, data: { state: "DISCARDED" } });
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, DISCARD_OPERATION, hash, { previewId, previewHash: preview.previewHash });
      return viewOf({ ...preview, state: "DISCARDED" }, now);
    });
  });
}
