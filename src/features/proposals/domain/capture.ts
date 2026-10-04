import { createHash } from "node:crypto";
import { LIMITS, type ScopeDocument } from "../../drafts/contracts/scope-document.ts";
import { byId } from "../../drafts/domain/graph.ts";
import { SOURCE_LIMITS } from "../../sources/contracts/source-version.ts";
import {
  AI_LIMITS, CAPTURE_SCHEMA_VERSION, PROMPT_VERSION, RESULT_SCHEMA_VERSION,
  type CapturedEdge, type CapturedFlow, type CapturedInput, type CapturedNode, type CapturedSource, type StartRunInput,
} from "../contracts/tasks.ts";

/** Evidence is UTF-8 normalized once: drop a leading BOM and turn CRLF/CR into LF. Everything else is preserved. */
export const normalizeEvidence = (text: string): string => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function emit(value: unknown, spaced: boolean): string {
  const join = spaced ? ", " : ",";
  if (Array.isArray(value)) return `[${value.map((entry) => emit(entry, spaced)).join(join)}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}${spaced ? ": " : ":"}${emit(record[key], spaced)}`).join(join)}}`;
  }
  return JSON.stringify(value);
}
/**
 * The one canonical JSON form (recursively sorted keys, compact) that capture and result hashes are computed over. Bodies are stored
 * as JSONB, which reorders keys, so a reader recomputes a hash by canonicalizing the stored value, never the original text.
 */
export const canonicalJson = (value: unknown): string => emit(value, false);
/** Bytes of the value as PostgreSQL renders it (`octet_length(jsonb::text)`), the measure the database size CHECKs apply. */
export const jsonbTextBytes = (value: unknown): number => Buffer.byteLength(emit(value, true), "utf8");

/** Counts, bytes and hash are computed on the normalized text, never the submitted bytes. */
export function evidenceStats(raw: string) {
  const text = normalizeEvidence(raw);
  return { text, codePointCount: Array.from(text).length, utf8ByteCount: Buffer.byteLength(text, "utf8"), contentHash: sha256(text) };
}

export type SavedSource = { projectId: string; sourceId: string; sourceVersionId: string; currentVersionId: string; title: string; text: string; contentHash: string };
/** A coherent, already authorized saved read of one draft plus exactly the explicitly selected same-project source versions. */
export type SavedContext = {
  projectId: string; draftId: string; documentRevision: number; parentSnapshotId: string | null;
  document: ScopeDocument; sources: SavedSource[]; model: string;
};

const fail = (code: "INVALID_INPUT" | "INVALID_SOURCE_REFERENCE" | "DRAFT_REPLACED" | "STALE_DOCUMENT_REVISION" | "BASELINE_CHANGED" | "CONFLICT" | "LIMIT_EXCEEDED"): never => { throw new Error(code); };

function captureSources(saved: SavedContext, input: StartRunInput): CapturedSource[] {
  const loaded = new Map(saved.sources.map((source) => [source.sourceVersionId, source]));
  if (loaded.size !== saved.sources.length || loaded.size !== input.context.sources.length) fail("INVALID_SOURCE_REFERENCE");
  return input.context.sources.map((reference) => {
    const source = loaded.get(reference.sourceVersionId);
    if (!source || source.projectId !== saved.projectId) return fail("INVALID_SOURCE_REFERENCE");
    if (source.currentVersionId !== reference.expectedCurrentVersionId) return fail("CONFLICT"); // the head moved since the caller looked
    const stats = evidenceStats(source.text);
    if (stats.text !== source.text || stats.contentHash !== source.contentHash || stats.codePointCount > SOURCE_LIMITS.submissionCodePoints) return fail("INVALID_SOURCE_REFERENCE");
    return {
      sourceVersionId: source.sourceVersionId, sourceId: source.sourceId, title: source.title, text: stats.text, contentHash: stats.contentHash,
      codePointCount: stats.codePointCount, utf8ByteCount: stats.utf8ByteCount, expectedCurrentVersionId: reference.expectedCurrentVersionId,
    };
  }).sort((a, b) => (a.sourceVersionId < b.sourceVersionId ? -1 : 1));
}

const flowOf = (flow: ScopeDocument["flows"][string]): CapturedFlow => ({
  id: flow.id, version: flow.version, behaviourVersion: flow.behaviourVersion, title: flow.title, purpose: flow.purpose, classification: flow.classification, inclusion: flow.inclusion,
});
const nodeOf = (node: ScopeDocument["nodes"][string], readOnly: boolean): CapturedNode => ({
  id: node.id, flowId: node.flowId, version: node.version, behaviourVersion: node.behaviourVersion, kind: node.kind, label: node.label,
  description: node.description, actorLabel: node.actorLabel, assumptionNotes: [...node.assumptionNotes], readOnly,
});
const edgeOf = (edge: ScopeDocument["edges"][string]): CapturedEdge => ({
  id: edge.id, flowId: edge.flowId, version: edge.version, fromId: edge.fromId, toId: edge.toId, condition: edge.condition,
});

function captureGraph(saved: SavedContext, input: StartRunInput): { selection: CapturedInput["selection"]; graph: CapturedInput["graph"] } {
  const { flows, nodes, edges } = saved.document;
  const selected = input.context.selection;
  if (input.taskType === "PROPOSE_FLOW") {
    if (selected || Object.keys(flows).length >= LIMITS.flows) return fail(selected ? "INVALID_INPUT" : "LIMIT_EXCEEDED"); // a sixth flow could never be applied
    return {
      selection: null,
      graph: {
        flows: Object.values(flows).sort(byId).map(flowOf), nodes: Object.values(nodes).sort(byId).map((node) => nodeOf(node, true)),
        edges: Object.values(edges).sort(byId).map(edgeOf), boundaryNodeIds: [],
      },
    };
  }
  const flow = selected && flows[selected.flowId];
  if (!selected || !flow || !selected.nodeIds.length) return fail("INVALID_INPUT");
  const chosen = new Set(selected.nodeIds);
  for (const nodeId of chosen) if (nodes[nodeId]?.flowId !== flow.id) fail("INVALID_INPUT");
  const incident = Object.values(edges).filter((edge) => edge.flowId === flow.id && (chosen.has(edge.fromId) || chosen.has(edge.toId))).sort(byId);
  const boundary = [...new Set(incident.flatMap((edge) => [edge.fromId, edge.toId]).filter((nodeId) => !chosen.has(nodeId)))].sort();
  return {
    selection: { flowId: flow.id, nodeIds: [...chosen].sort() },
    graph: {
      flows: [flowOf(flow)], boundaryNodeIds: boundary, edges: incident.map(edgeOf),
      nodes: [...chosen, ...boundary].sort().map((nodeId) => nodeOf(nodes[nodeId]!, !chosen.has(nodeId))),
    },
  };
}

/**
 * Pure: turns a saved read and a strict request into the exact serialized capture. Identity (draft, revision, baseline), explicit
 * selection and source head expectations must match what was saved; nothing is truncated, and nothing outside the selection plus its
 * incident edges and read-only boundary neighbours is captured for Improve.
 */
export function captureInput(saved: SavedContext, input: StartRunInput): { capture: CapturedInput; serialized: string; hash: string } {
  if (input.draftId !== saved.draftId) fail("DRAFT_REPLACED");
  if (input.expectedDocumentRevision !== saved.documentRevision) fail("STALE_DOCUMENT_REVISION");
  if (input.expectedParentSnapshotId !== saved.parentSnapshotId) fail("BASELINE_CHANGED");
  const prompt = normalizeEvidence(input.prompt);
  if (!prompt.trim() || Array.from(prompt).length > AI_LIMITS.promptCodePoints) fail("INVALID_INPUT");
  const sources = captureSources(saved, input);
  const { selection, graph } = captureGraph(saved, input);
  const capture: CapturedInput = {
    schemaVersion: CAPTURE_SCHEMA_VERSION, taskType: input.taskType, prompt, promptHash: sha256(prompt),
    draftId: saved.draftId, documentRevision: saved.documentRevision, parentSnapshotId: saved.parentSnapshotId,
    selection, graph, graphHash: sha256(canonicalJson(graph)), sources,
    versions: { prompt: PROMPT_VERSION, resultSchema: RESULT_SCHEMA_VERSION, model: saved.model },
    limits: {
      maxInputTokens: AI_LIMITS.maxInputTokens, maxOutputTokens: AI_LIMITS.maxOutputTokens, maxGraphNodes: AI_LIMITS.maxGraphNodes,
      maxGraphEdges: AI_LIMITS.maxGraphEdges, operations: AI_LIMITS.operations, resultBytes: AI_LIMITS.resultBytes,
    },
  };
  if (jsonbTextBytes(capture) > AI_LIMITS.captureBytes) fail("LIMIT_EXCEEDED");
  const serialized = canonicalJson(capture);
  return { capture, serialized, hash: sha256(serialized) };
}
