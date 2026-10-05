import type { FlowFields, NodeFields, GraphCommand } from "../../drafts/contracts/commands.ts";
import { LIMITS, type EdgeRecord, type FlowRecord, type NodeRecord, type SourceRef } from "../../drafts/contracts/scope-document.ts";
import { id, idList, invalid, keys, object, oneOf, text, version } from "../../drafts/contracts/strict.ts";
import { keyPattern } from "../../projects/contracts/project.ts";

// Stage 06 AI task contracts (Data 04/05, API "AI actions"). Exactly two tasks; nothing here accepts chat history,
// a conversation, previous AI output or a model-chosen authority. Provider SDK types never appear in this file.
export const TASK_KINDS = ["PROPOSE_FLOW", "REFINE_FLOW_SELECTION"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Capture and result bounds are measured as PostgreSQL stores them (jsonbTextBytes), so an accepted body never fails its CHECK.
export const AI_LIMITS = {
  promptCodePoints: 8_000, maxInputTokens: 16_000, maxOutputTokens: 6_000, maxGraphNodes: 20, maxGraphEdges: 40,
  runPageSize: 50, startBodyBytes: 64 * 1024, captureBytes: 256 * 1024, resultBytes: 128 * 1024,
  ownerConcurrentRuns: 2, ownerDailyRuns: 30, applicableResults: 10,
  // Operational default, not a product promise: start attempts per actor per minute, counted by the keyed AI_ADMISSION bucket.
  admissionAttemptsPerMinute: 30,
  operations: 100, dependsOn: 100, assumptions: 20, assumptionCodePoints: 2_000, citations: 100, excerptCodePoints: 2_000,
} as const;

export const CAPTURE_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const PROMPT_VERSION = "2026-10-06.1";

export type { SourceRef } from "../../drafts/contracts/scope-document.ts";
export type StartRunInput = {
  key: string; taskType: TaskKind; prompt: string; draftId: string; expectedDocumentRevision: number; expectedParentSnapshotId: string | null;
  context: { selection: { flowId: string; nodeIds: string[] } | null; sources: { sourceVersionId: string; expectedCurrentVersionId: string }[] };
};

/** The request body without its receipt key, in the fixed order every hash and size is computed over. */
export const startBody = (input: StartRunInput) => ({
  taskType: input.taskType, prompt: input.prompt, draftId: input.draftId, expectedDocumentRevision: input.expectedDocumentRevision,
  expectedParentSnapshotId: input.expectedParentSnapshotId, context: input.context,
});

/** Bytes of the canonical request body. The bound applies before any database read; nothing is truncated to fit. */
export const startBodyBytes = (input: StartRunInput): number => new TextEncoder().encode(JSON.stringify(startBody(input))).length;

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
  const input: StartRunInput = {
    key, taskType, prompt, draftId: id(body.draftId), expectedDocumentRevision: version(body.expectedDocumentRevision),
    expectedParentSnapshotId: body.expectedParentSnapshotId === null ? null : id(body.expectedParentSnapshotId), context: { selection, sources },
  };
  if (startBodyBytes(input) > AI_LIMITS.startBodyBytes) throw new Error("LIMIT_EXCEEDED", { cause: "START_BODY_BYTES" });
  return input;
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
  /** The project event sequence of this run's last committed change (the aiRevision it advanced to). */
  lastEventSequence: number;
};
export type RunAttemptView = { number: number; outcome: string | null; callMayHaveStarted: boolean; startedAt: string; usage: RunUsage };
/** Apply is derived, never a competing state: UNAVAILABLE (no applicable proposal, cancelled, expired or archived), STALE (draft, revision or baseline moved) or APPLICABLE. */
export type RunApplicability = "APPLICABLE" | "STALE" | "UNAVAILABLE";
export type RunView = RunSummary & {
  draftId: string; documentRevision: number; parentSnapshotId: string | null; model: string;
  capture: CapturedInput | null; result: ValidatedProposal | null; resultHash: string | null; attempts: RunAttemptView[];
  applicability: RunApplicability; applicabilityReasons: RunApplicabilityReason[]; diff: ProposalDiff | null; application: RunApplication | null; expiresAt: string | null;
};
export type RunPage = { runs: RunSummary[]; nextCursor: string | null };

/** Capture projection only: positions, origin and trust absent from the capture are never invented as diff facts. */
export type ProposalDiff = {
  selectedOperationIds: string[];
  before: CapturedInput["graph"];
  after: CapturedInput["graph"];
  createdIds: string[];
  updatedIds: string[];
  retiredIds: string[];
};

export type ApplyRunInput = {
  key: string; draftId: string; expectedDocumentRevision: number; expectedParentSnapshotId: string | null;
  resultHash: string; selectedOperationIds: string[];
};
export type AppliedRun = {
  applicationId: string; runId: string; draftId: string; documentRevision: number; layoutRevision: number;
  eventSequence: number; aiRevision: number; replayed: boolean;
};
export type DiscardRunInput = { key: string; expectedResultHash: string };
export type DiscardedRun = { runId: string; disposition: "DISCARDED"; aiRevision: number; replayed: boolean };

const resultHash = (raw: unknown): string => typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : invalid();
export function parseApplyRunInput(raw: unknown, key: string): ApplyRunInput {
  if (!keyPattern.test(key)) invalid();
  const body = object(raw);
  keys(body, ["draftId", "expectedDocumentRevision", "expectedParentSnapshotId", "resultHash", "selectedOperationIds"]);
  if (!Array.isArray(body.selectedOperationIds) || !body.selectedOperationIds.length || body.selectedOperationIds.length > AI_LIMITS.operations) invalid();
  const selectedOperationIds = body.selectedOperationIds.map(value => typeof value === "string" && LOCAL_REF.test(value) ? value : invalid());
  if (new Set(selectedOperationIds).size !== selectedOperationIds.length) invalid();
  return { key, draftId: id(body.draftId), expectedDocumentRevision: version(body.expectedDocumentRevision),
    expectedParentSnapshotId: body.expectedParentSnapshotId === null ? null : id(body.expectedParentSnapshotId), resultHash: resultHash(body.resultHash), selectedOperationIds };
}
export function parseDiscardRunInput(raw: unknown, key: string): DiscardRunInput {
  if (!keyPattern.test(key)) invalid();
  const body = object(raw); keys(body, ["expectedResultHash"]);
  return { key, expectedResultHash: resultHash(body.expectedResultHash) };
}

export type RunApplicabilityReason = "APPLIED" | "DISCARDED" | "EXPIRED" | "PROJECT_INACTIVE" | "CANCEL_REQUESTED" | "NOT_SUCCEEDED" | "INVALID_CAPTURE" | "INVALID_RESULT" | "BODY_UNAVAILABLE" | "CLARIFICATION" | "DRAFT_REPLACED" | "DOCUMENT_CHANGED" | "BASELINE_CHANGED" | "SOURCE_HEAD_CHANGED";
/** Immutable application evidence; retained independently of the seven-day run bodies and current graph. */
export type RunApplication = {
  id: string; runId: string; draftId: string; actorId: string; promptSourceVersionId: string; resultHash: string;
  selectedOperations: ProposalOperation[]; actualOperations: GraphCommand[]; idMap: Record<string, string>; createdIdMap: Record<string, string>;
  evidence: { changedIds: string[]; before: (FlowRecord | NodeRecord | EdgeRecord)[]; after: (FlowRecord | NodeRecord | EdgeRecord)[]; assumptions: string[]; citations: SourceRef[] };
  sourceVersionIds: string[]; beforeDocumentRevision: number; afterDocumentRevision: number; beforeLayoutRevision: number; afterLayoutRevision: number; createdAt: string;
};
