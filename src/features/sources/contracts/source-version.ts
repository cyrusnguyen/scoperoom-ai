import { id, invalid, keys, object, text, version } from "../../drafts/contracts/strict.ts";

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

export type SourceKind = "USER_TEXT" | "USER_UPLOAD" | "QUESTION_ANSWER" | "AI_PROMPT" | "PROMOTED_GRAPH";
/** Kinds that take one of the 30 active user-managed document slots; prompts and answers are internal evidence. */
export const USER_SOURCE_KINDS: readonly SourceKind[] = ["USER_TEXT", "USER_UPLOAD", "PROMOTED_GRAPH"];
export const USER_DOCUMENT_LIMIT = 30;
export const SOURCE_TITLE_LIMIT = 120;
export const SOURCE_PAGE_SIZE = 50;
/** 50,000 code points can need up to six JSON bytes each (escaped controls), plus the title and keys. */
export const SOURCE_BODY_LIMIT = 320 * 1024;

export type SourceScope = "user" | "archived" | "internal";
export type SourceHead = {
  id: string; kind: SourceKind; title: string; displayNickname: string | null; archived: boolean; version: number;
  currentVersionId: string; currentSequence: number; versionCount: number; createdBy: string; createdAt: string;
};
export type SourceUsage = { activeUserDocuments: number; retainedVersions: number; codePoints: number };
export type SourcePage = { items: SourceHead[]; nextCursor: string | null; usage: SourceUsage; sourcesRevision: number };
export type SourceVersionSummary = { id: string; sequence: number; title: string; contentHash: string; codePointCount: number; createdBy: string; createdAt: string };
export type SourceVersionPage = { items: SourceVersionSummary[]; nextCursor: number | null };
export type SourceWriteResult = { sourceId: string; sourceVersionId: string; version: number; sequence: number; sourcesRevision: number; eventSequence: number };

/** Evidence is normalized once: drop one leading BOM and turn CRLF/CR into LF. Everything else is preserved. */
export const normalizeEvidence = (raw: string): string => raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/** The excerpt is a literal substring of exactly its inclusive one-based line range (Data02 SourceRef). */
export function citationMatches(source: string, ref: { startLine: number; endLine: number; excerpt: string }): boolean {
  const lines = source.split(LINE_FEED);
  return ref.startLine >= 1 && ref.endLine >= ref.startLine && ref.endLine <= lines.length && lines.slice(ref.startLine - 1, ref.endLine).join(LINE_FEED).includes(ref.excerpt);
}

const sourceText = (value: unknown) => {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\u0000")) invalid();
  return value;
};
const title = (value: unknown) => text(value, SOURCE_TITLE_LIMIT, true);

export function parseCreateSource(raw: unknown) {
  const body = object(raw);
  keys(body, ["title", "text"], ["uploaded"]);
  if (body.uploaded !== undefined && typeof body.uploaded !== "boolean") invalid();
  return { title: title(body.title), text: sourceText(body.text), uploaded: body.uploaded === true };
}

export function parseCorrectSource(raw: unknown) {
  const body = object(raw);
  keys(body, ["expectedSourceRecordVersion", "expectedCurrentVersionId", "title", "text"]);
  return { expectedSourceRecordVersion: version(body.expectedSourceRecordVersion), expectedCurrentVersionId: id(body.expectedCurrentVersionId), title: title(body.title), text: sourceText(body.text) };
}

export function parseUpdateSource(raw: unknown) {
  const body = object(raw);
  keys(body, ["expectedSourceRecordVersion"], ["archived", "displayNickname"]);
  if (!Object.hasOwn(body, "archived") && !Object.hasOwn(body, "displayNickname")) invalid();
  if (Object.hasOwn(body, "archived") && typeof body.archived !== "boolean") invalid();
  return {
    expectedSourceRecordVersion: version(body.expectedSourceRecordVersion),
    ...(Object.hasOwn(body, "archived") ? { archived: body.archived as boolean } : {}),
    ...(Object.hasOwn(body, "displayNickname") ? { displayNickname: body.displayNickname === null ? null : text(body.displayNickname, SOURCE_TITLE_LIMIT, true) } : {}),
  };
}

export function parseGraphSource(raw: unknown) {
  const body = object(raw);
  keys(body, ["expectedDocumentRevision", "flowId", "title"]);
  return { expectedDocumentRevision: version(body.expectedDocumentRevision), flowId: id(body.flowId), title: title(body.title) };
}

/** A stored receipt result: identifiers and counters only. */
export function parseSourceWriteResult(value: unknown): SourceWriteResult {
  const result = object(value);
  keys(result, ["sourceId", "sourceVersionId", "version", "sequence", "sourcesRevision", "eventSequence"]);
  const counter = (entry: unknown) => { if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) invalid(); return entry; };
  return { sourceId: id(result.sourceId), sourceVersionId: id(result.sourceVersionId), version: version(result.version), sequence: version(result.sequence), sourcesRevision: counter(result.sourcesRevision), eventSequence: counter(result.eventSequence) };
}
