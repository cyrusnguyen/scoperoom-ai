import type { FlowFileV1 } from "./flow-file.ts";

/** Durable import identities are retained indefinitely; these caps bound their database footprint. */
export const FLOW_IMPORT_PREVIEW_LIMITS = {
  actor: { rows: 1_000, bodies: 10, bodyBytes: 8 * 1024 * 1024, creationsPerHour: 20 },
  project: { rows: 2_000, bodies: 25, bodyBytes: 16 * 1024 * 1024, creationsPerHour: 60 },
} as const;

export type ImportMapping = { flowId: string; nodes: Record<string, string>; edges: Record<string, string> };
export type ImportApplyResult = {
  previewId: string; draftId: string; flowId: string; mapping: ImportMapping;
  documentRevision: number; layoutRevision: number; eventSequence: number;
};
export type ImportApplyResponse = ImportApplyResult & { replayed: boolean };
export type ImportApplyInput = { key: string; draftId: string; previewHash: string };
export type ImportFidelityReport = {
  nodeCount: number; edgeCount: number; omittedLinkHintCount: number; geometry: "SUPPLIED" | "AUTOMATIC";
};
export type ImportPreviewView = {
  id: string; projectId: string; draftId: string; previewHash: string; expiresAt: string;
  expectedDocumentRevision: number; state: "READY" | "DISCARDED" | "EXPIRED" | "APPLIED";
  file: FlowFileV1 | null; positions: NonNullable<FlowFileV1["positions"]> | null;
  fidelityReport: ImportFidelityReport | null; result: ImportApplyResult | null;
};
