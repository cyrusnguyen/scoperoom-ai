import type { FlowFields, NodeFields } from "../../drafts/contracts/commands.ts";
import { LIMITS, type EdgeRecord, type FlowRecord, type NodeRecord } from "../../drafts/contracts/scope-document.ts";
import { id, idList, invalid, keys, object, oneOf, text, version } from "../../drafts/contracts/strict.ts";
import { keyPattern } from "../../projects/contracts/project.ts";

// Stage 06 AI task contracts (Data 04/05, API "AI actions"). Exactly two tasks; nothing here accepts chat history,
// a conversation, previous AI output or a model-chosen authority. Provider SDK types never appear in this file.
export const TASK_KINDS = ["PROPOSE_FLOW", "REFINE_FLOW_SELECTION"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Capture and result bounds are measured as PostgreSQL stores them (jsonbTextBytes), so an accepted body never fails its CHECK.
export const AI_LIMITS = {
  promptCodePoints: 8_000, maxInputTokens: 16_000, maxOutputTokens: 6_000, maxGraphNodes: 20, maxGraphEdges: 40,
  captureBytes: 256 * 1024, resultBytes: 128 * 1024,
  operations: 100, dependsOn: 100, assumptions: 20, assumptionCodePoints: 2_000, citations: 100, excerptCodePoints: 2_000,
} as const;

export const CAPTURE_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const PROMPT_VERSION = "2026-10-03.1";

export type SourceRef = { sourceVersionId: string; startLine: number; endLine: number; excerpt: string };
export type StartRunInput = {
  key: string; taskType: TaskKind; prompt: string; draftId: string; expectedDocumentRevision: number; expectedParentSnapshotId: string | null;
  context: { selection: { flowId: string; nodeIds: string[] } | null; sources: { sourceVersionId: string; expectedCurrentVersionId: string }[] };
};

/** Strict POST body plus the server-validated receipt key. The prompt is validated again, once normalized, by captureInput. */
export function parseStartRunInput(raw: unknown, key: string): StartRunInput {
  if (!keyPattern.test(key)) invalid();
  const body = object(raw);
  keys(body, ["taskType", "prompt", "draftId", "expectedDocumentRevision", "expectedParentSnapshotId", "context"]);
  const taskType = oneOf(body.taskType, TASK_KINDS);
  const context = object(body.context);
  keys(context, ["selection", "sources"]);
  if (!Array.isArray(context.sources)) invalid();
  const sources = context.sources.map((entry) => {
    const source = object(entry);
    keys(source, ["sourceVersionId", "expectedCurrentVersionId"]);
    return { sourceVersionId: id(source.sourceVersionId), expectedCurrentVersionId: id(source.expectedCurrentVersionId) };
  });
  if (new Set(sources.map((source) => source.sourceVersionId)).size !== sources.length) invalid();
  let selection: StartRunInput["context"]["selection"] = null;
  if (taskType === "REFINE_FLOW_SELECTION") {
    const chosen = object(context.selection);
    keys(chosen, ["flowId", "nodeIds"]);
    selection = { flowId: id(chosen.flowId), nodeIds: idList(chosen.nodeIds, LIMITS.nodes) };
    if (!selection.nodeIds.length) invalid();
  } else if (context.selection !== null) invalid();
  const prompt = text(body.prompt, AI_LIMITS.promptCodePoints * 2, true); // loose raw bound; captureInput applies the exact normalized bound
  return {
    key, taskType, prompt, draftId: id(body.draftId), expectedDocumentRevision: version(body.expectedDocumentRevision),
    expectedParentSnapshotId: body.expectedParentSnapshotId === null ? null : id(body.expectedParentSnapshotId), context: { selection, sources },
  };
}

export type CapturedFlow = Omit<FlowRecord, "confirmation" | "verificationMethod">;
export type CapturedNode = Pick<NodeRecord, "id" | "flowId" | "version" | "behaviourVersion" | "kind" | "label" | "description" | "actorLabel" | "assumptionNotes"> & { readOnly: boolean };
export type CapturedEdge = Pick<EdgeRecord, "id" | "flowId" | "version" | "fromId" | "toId" | "condition">;
export type CapturedSource = {
  sourceVersionId: string; sourceId: string; title: string; text: string; contentHash: string; codePointCount: number; utf8ByteCount: number;
  expectedCurrentVersionId: string;
};
/** The exact immutable model input (Data 04 "Atomic admission and captured input"); `graph` is Generate's whole saved graph or Improve's selection scope. */
export type CapturedInput = {
  schemaVersion: typeof CAPTURE_SCHEMA_VERSION; taskType: TaskKind; prompt: string; promptHash: string;
  draftId: string; documentRevision: number; parentSnapshotId: string | null;
  selection: { flowId: string; nodeIds: string[] } | null;
  graph: { flows: CapturedFlow[]; nodes: CapturedNode[]; edges: CapturedEdge[]; boundaryNodeIds: string[] };
  graphHash: string; sources: CapturedSource[];
  versions: { prompt: string; resultSchema: number; model: string };
  limits: Pick<typeof AI_LIMITS, "maxInputTokens" | "maxOutputTokens" | "maxGraphNodes" | "maxGraphEdges" | "operations" | "resultBytes">;
};

// Result wire schema (envelope `{schemaVersion:1,kind,...}`, no extra keys). Operation edits mirror the manual draft commands minus
// authority, geometry and version fields. An EntityId is a captured UUID or an operation-local `ref` the application resolves.
export const EDIT_COMMANDS = ["CREATE_FLOW", "ADD_NODE", "UPDATE_NODE", "DELETE_NODES", "ADD_EDGE", "UPDATE_EDGE", "RECONNECT_EDGE", "DELETE_EDGE"] as const;
export type EditCommand = (typeof EDIT_COMMANDS)[number];
/** Generate creates one new flow group; Improve edits selected steps and permitted incident edges, never whole flows. */
export const TASK_EDITS = {
  PROPOSE_FLOW: ["CREATE_FLOW", "ADD_NODE", "ADD_EDGE"],
  REFINE_FLOW_SELECTION: ["ADD_NODE", "UPDATE_NODE", "DELETE_NODES", "ADD_EDGE", "UPDATE_EDGE", "RECONNECT_EDGE", "DELETE_EDGE"],
} as const satisfies Record<TaskKind, readonly EditCommand[]>;
export const LOCAL_REF = /^[a-z][a-z0-9_-]{0,31}$/;

export type EntityId = string;
export type ProposalEdit =
  | { command: "CREATE_FLOW"; payload: { ref: string } & FlowFields }
  | { command: "ADD_NODE"; payload: { ref: string; flowId: EntityId } & Omit<NodeFields, "assumptionNotes"> }
  | { command: "UPDATE_NODE"; payload: { nodeId: EntityId } & Partial<NodeFields> }
  | { command: "DELETE_NODES"; payload: { flowId: EntityId; nodeIds: EntityId[]; removeEdgeIds: EntityId[] } }
  | { command: "ADD_EDGE"; payload: { flowId: EntityId; fromId: EntityId; toId: EntityId; condition: string } }
  | { command: "UPDATE_EDGE"; payload: { edgeId: EntityId; condition: string } }
  | { command: "RECONNECT_EDGE"; payload: { edgeId: EntityId; fromId: EntityId; toId: EntityId } }
  | { command: "DELETE_EDGE"; payload: { edgeId: EntityId } };
export type ProposalOperation = { id: string; dependsOn: string[]; edit: ProposalEdit };
export type ValidatedProposal =
  | { schemaVersion: 1; kind: "proposal"; operations: ProposalOperation[]; assumptions: string[]; citations: SourceRef[] }
  | { schemaVersion: 1; kind: "clarification"; message: string };

export type RunState = "QUEUED" | "RUNNING" | "VALIDATING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export type RunDisposition = "AVAILABLE" | "APPLIED" | "DISCARDED" | "EXPIRED";
export type RunUsage = { inputTokens: number | null; outputTokens: number | null };
export type RunSummary = {
  id: string; taskType: TaskKind; state: RunState; disposition: RunDisposition | null; actorId: string; flowId: string | null;
  createdAt: string; deadlineAt: string; terminalAt: string | null; cancelRequestedAt: string | null; failureCode: string | null; usage: RunUsage;
};
export type RunAttemptView = { number: number; outcome: string | null; callMayHaveStarted: boolean; startedAt: string; usage: RunUsage };
export type RunView = RunSummary & {
  draftId: string; documentRevision: number; parentSnapshotId: string | null; model: string;
  capture: CapturedInput | null; result: ValidatedProposal | null; resultHash: string | null; attempts: RunAttemptView[];
};
export type RunPage = { runs: RunSummary[]; nextCursor: string | null };
