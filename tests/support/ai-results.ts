import { createHash, randomUUID } from "node:crypto";
import { emptyDraft } from "../../src/features/drafts/contracts/scope-document.ts";
import { parseStartRunInput, type CapturedInput } from "../../src/features/proposals/contracts/tasks.ts";
import { captureInput, type SavedContext } from "../../src/features/proposals/domain/capture.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const SOURCE_TEXT = "line one\nline two\nline three";

/** A saved graph a-b-c-d in one flow (plus a stray in another) with one cited source, and ready-made Generate and Improve captures. */
export function resultFixture() {
  const projectId = randomUUID(), draftId = randomUUID(), flowId = randomUUID(), otherFlowId = randomUUID();
  const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), stray: randomUUID(), foreign: randomUUID() };
  const { document } = emptyDraft();
  const flow = (id: string, title: string) => ({ id, version: 2, behaviourVersion: 1, title, purpose: "p", classification: "USER_JOURNEY" as const, inclusion: "UNDECIDED" as const, confirmation: null, verificationMethod: null });
  const node = (id: string, flow: string, label: string) => ({ id, flowId: flow, version: 3, behaviourVersion: 1, kind: "ACTION" as const, label, description: "", actorLabel: "", origin: "HUMAN" as const, sourceRefs: [] as [], assumptionNotes: [] });
  const edge = (id: string, from: string, to: string) => ({ id, flowId, version: 4, fromId: from, toId: to, condition: "", origin: "HUMAN" as const, sourceRefs: [] as [] });
  document.flows = { [flowId]: flow(flowId, "Main"), [otherFlowId]: flow(otherFlowId, "Other") };
  document.nodes = { [ids.a]: node(ids.a, flowId, "A"), [ids.b]: node(ids.b, flowId, "B"), [ids.c]: node(ids.c, flowId, "C"), [ids.d]: node(ids.d, flowId, "D"), [ids.stray]: node(ids.stray, otherFlowId, "S") };
  const e1 = randomUUID(), e2 = randomUUID(), e3 = randomUUID();
  document.edges = { [e1]: edge(e1, ids.a, ids.b), [e2]: edge(e2, ids.b, ids.c), [e3]: edge(e3, ids.c, ids.d) };
  const sourceVersionId = randomUUID();
  const source = { projectId, sourceId: randomUUID(), sourceVersionId, currentVersionId: sourceVersionId, title: "Notes", text: SOURCE_TEXT, contentHash: sha(SOURCE_TEXT) };
  const saved = (withSource: boolean): SavedContext => ({ projectId, draftId, documentRevision: 7, parentSnapshotId: null, document, sources: withSource ? [source] : [], model: "model-x" });
  const sources = [{ sourceVersionId, expectedCurrentVersionId: sourceVersionId }];
  const base = { draftId, expectedDocumentRevision: 7, expectedParentSnapshotId: null };
  const generate = (): CapturedInput => captureInput(saved(true), parseStartRunInput({ ...base, taskType: "PROPOSE_FLOW", prompt: "make a flow", context: { selection: null, sources } }, "k".repeat(24))).capture;
  /** Improve over `nodeIds` (default b and c): a and d are read-only boundary neighbours, e1 and e3 cross the boundary, e2 is internal. */
  const improve = (nodeIds = [ids.b, ids.c]): CapturedInput => captureInput(saved(true), parseStartRunInput({ ...base, taskType: "REFINE_FLOW_SELECTION", prompt: "tighten", context: { selection: { flowId, nodeIds }, sources } }, "k".repeat(24))).capture;
  return { ids, flowId, otherFlowId, edges: { e1, e2, e3 }, sourceVersionId, generate, improve };
}

export const flowOp = (id = "op1", ref = "flow1", dependsOn: string[] = []) => ({
  id, dependsOn, edit: { command: "CREATE_FLOW", payload: { ref, title: "Checkout", purpose: "Pay", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } },
});
export const nodeOp = (id: string, ref: string, flowId: string, dependsOn: string[], label = "Step") => ({
  id, dependsOn, edit: { command: "ADD_NODE", payload: { ref, flowId, kind: "ACTION", label, description: "", actorLabel: "" } },
});
export const edgeOp = (id: string, flowId: string, fromId: string, toId: string, dependsOn: string[]) => ({
  id, dependsOn, edit: { command: "ADD_EDGE", payload: { flowId, fromId, toId, condition: "" } },
});
export const proposal = (operations: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, kind: "proposal", operations, assumptions: [], citations: [], ...extra });
/** A complete valid Generate proposal: one flow, two nodes, one edge, one exact citation. */
export const goodGenerate = (sourceVersionId: string) => proposal(
  [flowOp(), nodeOp("op2", "n1", "flow1", ["op1"]), nodeOp("op3", "n2", "flow1", ["op1"]), edgeOp("op4", "flow1", "n1", "n2", ["op2", "op3"])],
  { assumptions: ["Payment is online"], citations: [{ sourceVersionId, startLine: 2, endLine: 3, excerpt: "line two\nline three" }] },
);
