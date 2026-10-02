import type { Direction, Side } from "../../drafts/contracts/draft-layout.ts";
import type { Classification, Inclusion, NodeKind } from "../../drafts/contracts/scope-document.ts";

export type FlowFileNode = { id: string; kind: NodeKind; label: string; description: string; actorLabel: string | null; assumptionNotes: string[] };
export type FlowFileEdge = { id: string; fromId: string; toId: string; condition: string | null };
export type FlowFilePosition = { nodeId: string; x: number; y: number };
export type FlowFileEdgeSides = { edgeId: string; from: Side; to: Side };
export type FlowFileLinkHint = { nodeId: string; requirementId: string; requirementTitle: string };
export type FlowFileOrigin =
  | { kind: "DRAFT"; documentRevision: number; layoutRevision: number }
  | { kind: "SNAPSHOT"; documentRevision: number; layoutRevision: number; sourceInclusion: Inclusion; snapshotId?: string; contentHash?: string; reviewHash?: string };

/** Closed, portable native interchange shape. File-local IDs deliberately are not database IDs. */
export type FlowFileV1 = {
  format: "scoperoom-flow"; formatVersion: 1; exportedAt: string; producerVersion: string;
  flow: { title: string; purpose: string; classification: Classification; direction: Direction };
  nodes: FlowFileNode[]; edges: FlowFileEdge[]; origin: FlowFileOrigin;
  positions?: FlowFilePosition[]; edgeSides?: FlowFileEdgeSides[];
  viewport?: { x: number; y: number; zoom: number }; linkHints?: FlowFileLinkHint[];
};
