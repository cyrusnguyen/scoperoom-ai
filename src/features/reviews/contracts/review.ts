import type { DraftLayout } from "../../drafts/contracts/draft-layout.ts";
import { parseDraftPair, type DraftView, type ScopeDocument } from "../../drafts/contracts/scope-document.ts";
import { id, invalid, keys, object, oneOf, text, version } from "../../drafts/contracts/strict.ts";
import { lineStarts, SOURCE_LIMITS, type SourceVersionView } from "../../sources/contracts/source-version.ts";
export const REVIEW_BODY_LIMIT = 4 * 1024;
export const WITHDRAW_BODY_LIMIT = 32 * 1024;
export type FreezeInput = {
  expectedDocumentRevision: number;
  expectedLayoutRevision: number;
  expectedParentSnapshotId: string | null;
  expectedApprovalPolicyVersion: number;
};
export type WithdrawInput = {
  expectedReviewVersion: number;
  reason: string;
};
export type CandidateErrorCode = "INVALID_DRAFT" | "NO_INCLUDED_CONTENT" | "CONFIRMATION_REQUIRED" | "LINK_REVIEW_REQUIRED" | "INVALID_CITATION" | "EMPTY_FLOW" | "NO_START" | "NO_OUTCOME" | "UNCONNECTED_STEP" | "UNLABELLED_BRANCH" | "START_HAS_INCOMING" | "OUTCOME_HAS_OUTGOING" | "ACTION_OUTGOING_COUNT" | "DECISION_OUTGOING_COUNT" | "DUPLICATE_BRANCH_LABEL" | "UNREACHABLE_FROM_START" | "CANNOT_REACH_OUTCOME" | "NO_SEMANTIC_CHANGE";
export type CandidateError = {
  code: CandidateErrorCode;
  targetId: string | null;
};
export type CandidateCheck = {
  valid: boolean;
  errors: CandidateError[];
  truncated: boolean;
};
export type CandidateInput = {
  draft: DraftView;
  evidence: SourceVersionView[];
  baseline: ScopeDocument | null;
};
export type CandidatePayload = {
  canonicalizationVersion: 1;
  schemaVersion: 3;
  projectId: string;
  projectName: string;
  sourceDraftId: string;
  capturedDocumentRevision: number;
  capturedLayoutRevision: number;
  documentJson: ScopeDocument;
  layoutJson: DraftLayout;
  evidenceManifest: SourceVersionView[];
  policySnapshot: {
    designatedApproverId: string;
    approvalPolicyVersion: number;
  };
  parentSnapshotId: string | null;
  agreementIntent: "INCLUDED_SCOPE";
  requestResolution: null;
};
/** The browser supplies guards only; the server captures saved content and policy. */
export function parseFreezeInput(raw: unknown): FreezeInput {
  const body = object(raw);
  keys(body, ["expectedDocumentRevision", "expectedLayoutRevision", "expectedParentSnapshotId", "expectedApprovalPolicyVersion"]);
  return {
    expectedDocumentRevision: version(body.expectedDocumentRevision), expectedLayoutRevision: version(body.expectedLayoutRevision),
    expectedParentSnapshotId: body.expectedParentSnapshotId === null ? null : id(body.expectedParentSnapshotId),
    expectedApprovalPolicyVersion: version(body.expectedApprovalPolicyVersion),
  };
}
export function parseWithdrawInput(raw: unknown): WithdrawInput {
  const body = object(raw);
  keys(body, ["expectedReviewVersion", "reason"]);
  return {
    expectedReviewVersion: version(body.expectedReviewVersion), reason: text(body.reason, 4000, true)
  };
}
export const CANDIDATE_BYTES = 4 * 1024 * 1024;
export const REVIEW_STATES = ["OPEN", "APPROVED", "CHANGES_REQUESTED", "REJECTED", "WITHDRAWN", "SUPERSEDED", "STALE"] as const;
export type ReviewState = typeof REVIEW_STATES[number];
export type CandidateSnapshot = CandidatePayload & {
  id: string;
  contentHash: string;
  reviewHash: string;
  createdBy: string;
  createdAt: string;
};
export type ReviewPreview = {
  draftId: string;
  guards: FreezeInput;
  check: CandidateCheck;
  policySnapshot: CandidatePayload["policySnapshot"];
  openReviewId: string | null;
  reviewsRevision: number;
};
export type FreezeResult = {
  reviewId: string;
  snapshotId: string;
  reviewVersion: number;
  reviewHash: string;
  draftId: string;
  documentRevision: number;
  layoutRevision: number;
  eventSequence: number;
};
export type WithdrawResult = {
  reviewId: string;
  reviewVersion: number;
  state: "WITHDRAWN";
  eventSequence: number;
};
export type ReviewSummary = {
  reviewId: string;
  snapshotId: string;
  sourceDraftId: string;
  state: ReviewState;
  reviewVersion: number;
  reviewHash: string;
  createdAt: string;
  createdBy: string;
  lastEventSequence: number;
};
export type ReviewPage = {
  items: ReviewSummary[];
  nextCursor: string | null;
  reviewsRevision: number;
};
export type ReviewDetail = {
  review: ReviewSummary & {
    reason: string | null;
    publicationSequence: number | null;
    publishedAt: string | null;
  };
  snapshot: CandidateSnapshot;
  decision: null;
  draftChanges: {
    replaced: boolean;
    contentChanged: boolean;
    layoutChanged: boolean;
  };
};
export const reviewCounter = (entry: unknown): number => {
  if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
    invalid();
  }
  return entry;
};
export function reviewHashValue(entry: unknown): string {
  if (typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry)) {
    invalid();
  }
  return entry;
}
const timestamp = (entry: unknown) => {
  if (typeof entry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry) || !Number.isFinite(Date.parse(entry))) {
    invalid();
  }
  return entry;
};
/** Reject non-JSON primitives before canonicalization, including surrogates in arbitrary immutable origin metadata. */
export function validateCandidateJson(value: unknown): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    text(value, Number.MAX_SAFE_INTEGER);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      invalid();
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(validateCandidateJson);
    return;
  }
  const record = object(value);
  for (const [key, entry] of Object.entries(record)) {
    text(key, Number.MAX_SAFE_INTEGER);
    validateCandidateJson(entry);
  }
}
function parseEvidence(raw: unknown): SourceVersionView {
  const item = object(raw);
  keys(item, ["id", "sourceId", "kind", "sequence", "title", "text", "contentHash", "codePointCount", "utf8ByteCount", "lineStarts", "origin", "createdBy", "createdAt"]);
  const body = text(item.text, SOURCE_LIMITS.submissionCodePoints);
  const lines = lineStarts(body);
  if (!Array.isArray(item.lineStarts) || item.lineStarts.length !== lines.length || item.lineStarts.some((value, index) => value !== lines[index])) {
    invalid();
  }
  const codePointCount = reviewCounter(item.codePointCount), utf8ByteCount = reviewCounter(item.utf8ByteCount);
  if (codePointCount !== [...body].length || utf8ByteCount !== new TextEncoder().encode(body).length) {
    invalid();
  }
  validateCandidateJson(item.origin);
  return {
    id: id(item.id), sourceId: id(item.sourceId), kind: oneOf(item.kind, ["USER_TEXT", "USER_UPLOAD", "QUESTION_ANSWER", "AI_PROMPT", "PROMOTED_GRAPH"]), sequence: version(item.sequence), title: text(item.title, 120, true), text: body, contentHash: reviewHashValue(item.contentHash), codePointCount, utf8ByteCount, lineStarts: lines, origin: item.origin, createdBy: id(item.createdBy), createdAt: timestamp(item.createdAt)
  };
}
export function parseCandidatePayload(raw: unknown): CandidatePayload {
  validateCandidateJson(raw);
  const body = object(raw);
  keys(body, ["canonicalizationVersion", "schemaVersion", "projectId", "projectName", "sourceDraftId", "capturedDocumentRevision", "capturedLayoutRevision", "documentJson", "layoutJson", "evidenceManifest", "policySnapshot", "parentSnapshotId", "agreementIntent", "requestResolution"]);
  if (body.canonicalizationVersion !== 1 || body.schemaVersion !== 3 || body.agreementIntent !== "INCLUDED_SCOPE" || body.requestResolution !== null || !Array.isArray(body.evidenceManifest) || body.evidenceManifest.length > SOURCE_LIMITS.retainedVersions) {
    invalid();
  }
  const pair = parseDraftPair(body.documentJson, body.layoutJson), policy = object(body.policySnapshot);
  keys(policy, ["designatedApproverId", "approvalPolicyVersion"]);
  const evidenceManifest = body.evidenceManifest.map(parseEvidence);
  if (new Set(evidenceManifest.map(item => item.id)).size !== evidenceManifest.length || evidenceManifest.some((item, index) => index > 0 && evidenceManifest[index - 1].id >= item.id)) {
    invalid();
  }
  return {
    canonicalizationVersion: 1, schemaVersion: 3, projectId: id(body.projectId), projectName: text(body.projectName, 120, true), sourceDraftId: id(body.sourceDraftId), capturedDocumentRevision: version(body.capturedDocumentRevision), capturedLayoutRevision: version(body.capturedLayoutRevision), documentJson: pair.document, layoutJson: pair.layout, evidenceManifest, policySnapshot: {
      designatedApproverId: id(policy.designatedApproverId), approvalPolicyVersion: version(policy.approvalPolicyVersion)
    }, parentSnapshotId: body.parentSnapshotId === null ? null : id(body.parentSnapshotId), agreementIntent: "INCLUDED_SCOPE", requestResolution: null
  };
}
export function parseFreezeResult(raw: unknown): FreezeResult {
  const body = object(raw);
  keys(body, ["reviewId", "snapshotId", "reviewVersion", "reviewHash", "draftId", "documentRevision", "layoutRevision", "eventSequence"]);
  if (body.reviewVersion !== 1) {
    invalid();
  }
  return {
    reviewId: id(body.reviewId), snapshotId: id(body.snapshotId), reviewVersion: version(body.reviewVersion), reviewHash: reviewHashValue(body.reviewHash), draftId: id(body.draftId), documentRevision: version(body.documentRevision), layoutRevision: version(body.layoutRevision), eventSequence: reviewCounter(body.eventSequence)
  };
}
export function parseWithdrawResult(raw: unknown): WithdrawResult {
  const body = object(raw);
  keys(body, ["reviewId", "reviewVersion", "state", "eventSequence"]);
  if (body.state !== "WITHDRAWN") {
    invalid();
  }
  return {
    reviewId: id(body.reviewId), reviewVersion: version(body.reviewVersion), state: "WITHDRAWN", eventSequence: reviewCounter(body.eventSequence)
  };
}
