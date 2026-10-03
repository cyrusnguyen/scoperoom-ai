// Immutable evidence limits (Data 01 "Evidence budgets and immutable origin"). Every retained version, archived and internal prompts
// included, counts against the project-wide capacity; AI_PROMPT bypasses only the 30 active user-managed-document cap, which has no
// consumer yet. The writer enforces these under the project lock.
export const SOURCE_LIMITS = { submissionCodePoints: 50_000, retainedVersions: 500, projectCodePoints: 500_000 } as const;

export type SourceVersionView = {
  id: string; sourceId: string; kind: string; sequence: number; title: string; text: string; contentHash: string; codePointCount: number; utf8ByteCount: number;
  /** Code point offset where each line of the normalized text starts (line n starts at lineStarts[n - 1]). */
  lineStarts: number[]; origin: unknown; createdBy: string; createdAt: string;
};

const LINE_FEED = String.fromCharCode(10);

/** Evidence text is normalized to LF line endings, so a line starts at 0 and after each line feed. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  let offset = 0;
  for (const character of text) {
    offset += 1;
    if (character === LINE_FEED) starts.push(offset);
  }
  return starts;
}
