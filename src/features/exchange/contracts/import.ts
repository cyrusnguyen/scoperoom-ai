import type { FlowFileV1 } from "./flow-file.ts";

export type ImportMapping = { flowId: string; nodes: Record<string, string>; edges: Record<string, string> };
export type ImportApplyResult = {
  previewId: string; draftId: string; flowId: string; mapping: ImportMapping;
  documentRevision: number; layoutRevision: number; eventSequence: number;
};
export type ImportFidelityReport = {
  nodeCount: number; edgeCount: number; omittedLinkHintCount: number; geometry: "SUPPLIED" | "AUTOMATIC";
};
export type ImportPreviewView = {
  id: string; projectId: string; draftId: string; previewHash: string; expiresAt: string;
  expectedDocumentRevision: number; state: "READY" | "DISCARDED" | "EXPIRED" | "APPLIED";
  file: FlowFileV1 | null; positions: NonNullable<FlowFileV1["positions"]> | null;
  fidelityReport: ImportFidelityReport | null; result: ImportApplyResult | null;
};
