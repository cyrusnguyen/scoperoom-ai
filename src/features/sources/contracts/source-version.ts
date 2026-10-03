// Immutable evidence (Data 01 "Evidence budgets and immutable origin"). Stage 06 needs only the exact-version primitives behind
// mutating-prompt provenance and citations; Stage 07 adds library management and widens `origin`. Text is stored already normalized.
export const SOURCE_KINDS = ["USER_TEXT", "USER_UPLOAD", "QUESTION_ANSWER", "AI_PROMPT", "PROMOTED_GRAPH"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LIMITS = {
  title: 120, submissionCodePoints: 50_000, retainedVersions: 500, projectCodePoints: 500_000, activeUserDocuments: 30,
} as const;

export type SourceVersionView = {
  id: string; sourceId: string; kind: SourceKind; sequence: number; title: string; text: string;
  codePointCount: number; utf8ByteCount: number; contentHash: string; createdBy: string; createdAt: string; origin: null;
};
