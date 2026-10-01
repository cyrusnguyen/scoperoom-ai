import { createHash } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { arrange } from "../../drafts/server/layout.ts";
import { LIMITS, type ScopeDocument } from "../../drafts/contracts/scope-document.ts";
import { keyPattern, uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { checkReceipt, findReceipt, lockActor, lockProject, profileFor, readProject, receiptString, requestHash, requireActive, requireMember, saveReceipt, withDatabase, withReadSnapshot, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import type { FlowFileV1 } from "../contracts/flow-file.ts";
import type { ImportApplyResult, ImportFidelityReport, ImportPreviewView } from "../contracts/import.ts";
import { parseFlowFile } from "../domain/flow-file.ts";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const PREVIEW_OPERATION = "FLOW_IMPORT_PREVIEW_V1";
const DISCARD_OPERATION = "FLOW_IMPORT_DISCARD_V1";
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

async function clock(tx: Transaction) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  if (!row) throw new ProjectError("UNAVAILABLE");
  return row.now;
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
      const positions = parsed.suppliedPositions ?? automaticPositions(parsed.source);
      const fidelityReport: ImportFidelityReport = { nodeCount: parsed.source.nodes.length, edgeCount: parsed.source.edges.length, omittedLinkHintCount: parsed.source.linkHints?.length ?? 0, geometry: parsed.suppliedPositions ? "SUPPLIED" : "AUTOMATIC" };
      const hash = requestHash(PREVIEW_OPERATION, { projectId, draftId, previewId, actorId: profile.id, file: parsed.source, positions, fidelityReport });
      const [sizes] = await tx.$queryRaw<Array<{ valid: boolean }>>`SELECT octet_length(${JSON.stringify(parsed.source)}::jsonb::text) <= 1048576
        AND octet_length(${JSON.stringify(positions)}::jsonb::text) <= 262144 AND octet_length(${JSON.stringify(fidelityReport)}::jsonb::text) <= 65536 AS valid`;
      if (!sizes?.valid) throw new ProjectError("LIMIT_EXCEEDED");
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
      const preview = await tx.flowImportPreview.findFirst({ where: { id: previewId, projectId: project.id, actorId: profile.id } }) as StoredPreview | null;
      if (!preview) throw new ProjectError("NOT_FOUND");
      const now = await clock(tx);
      const hash = requestHash(DISCARD_OPERATION, { projectId, previewId, previewHash: preview.previewHash });
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) { checkReceipt(receipt, DISCARD_OPERATION, hash); return viewOf(preview, now); }
      if (preview.state === "APPLIED") return viewOf(preview, now);
      if (role !== "OWNER" && role !== "EDITOR") throw new ProjectError("FORBIDDEN");
      requireActive(project);
      if (preview.state === "READY" && preview.expiresAt > now) await tx.flowImportPreview.update({ where: { id: preview.id }, data: { state: "DISCARDED" } });
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, DISCARD_OPERATION, hash, { previewId, previewHash: preview.previewHash });
      return viewOf({ ...preview, state: preview.state === "READY" && preview.expiresAt > now ? "DISCARDED" : preview.state }, now);
    });
  });
}
