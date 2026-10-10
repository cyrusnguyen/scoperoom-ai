import type { RealtimeTopics } from "../../collaboration/contracts/topics.ts";
import type { DraftView } from "../../drafts/contracts/scope-document.ts";

export type { ProjectErrorCode } from "./errors.ts";

export type ProjectIdentity = { authUserId: string; displayName: string };
export type ProjectAccessRole = "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER";
export type CreateProjectInput = { name: string; key: string };
export type CreatedProject = { id: string; name: string; replayed: boolean };

export type ProjectListItem = { id: string; name: string; status: "ACTIVE" | "ARCHIVED"; role: ProjectAccessRole; ownerName: string; updatedAt: string };
export type ProjectGroup = { items: ProjectListItem[]; truncated: boolean };
export type ProjectCapacity = { entitled: boolean; activeOwned: number; maxOwned: number; canCreate: boolean };
export type ProjectLists = { owned: ProjectGroup; shared: ProjectGroup; archived: ProjectGroup; capacity: ProjectCapacity };

export type ProjectBootstrap = {
  project: { id: string; name: string; status: "ACTIVE" | "ARCHIVED"; role: ProjectAccessRole; ownerId: string };
  draft: DraftView;
  status: ProjectStatusView;
  realtime: RealtimeTopics;
};

/** `viewerId` is the caller's profile id: a page that sees another one has changed account and must tear down. */
export type ProjectStatusView = {
  viewerId: string; status: "ACTIVE" | "ARCHIVED"; role: ProjectAccessRole; version: number; settingsVersion: number; approvalPolicyVersion: number; membershipVersion: number;
  designatedApproverId: string | null; currentDraftId: string; documentRevision: number; layoutRevision: number; realtimeEpoch: string; eventSequence: number;
  /** Resource cursor derived from eventSequence (Data 04): the sequence of the last committed AI run change. */
  aiRevision: number;
  /** Resource cursor derived from eventSequence: the sequence of the last committed source change (Stage 07). */
  sourcesRevision: number;
  reviewsRevision: number;
  baselineSequence: number;
  approvedSnapshotId: string | null;
};

export const PROJECT_LIST_LIMIT = 100;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const keyPattern = /^[\x21-\x7e]{16,128}$/;

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
}

export function validateProjectCreateInput(input: unknown): CreateProjectInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidInput();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((field) => field !== "name" && field !== "key")) invalidInput();
  if (typeof value.name !== "string" || typeof value.key !== "string" || !keyPattern.test(value.key)) invalidInput();
  const name = value.name.normalize("NFC").trim();
  if (!name || Array.from(name).length > 120) invalidInput();
  return { name, key: value.key };
}
