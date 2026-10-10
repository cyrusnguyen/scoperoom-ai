import type { DirectoryMember } from "../../collaboration/ui/participants.ts";
import { roleLabel } from "../../projects/ui/format.ts";
import type { Inclusion } from "../../drafts/contracts/scope-document.ts";
import type { LinkState } from "../../scope/domain/scope.ts";
import type { ReviewDecision, ReviewState } from "../contracts/review.ts";

/** One visual tone per review outcome; review.css maps each tone to tokens.css colours. */
export type ReviewTone = "approved" | "open" | "pending" | "rejected" | "closed";

const STATES: Record<ReviewState, { label: string; tone: ReviewTone }> = {
  OPEN: { label: "Open", tone: "open" },
  APPROVED: { label: "Approved", tone: "approved" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "pending" },
  REJECTED: { label: "Rejected", tone: "rejected" },
  WITHDRAWN: { label: "Withdrawn", tone: "closed" },
  SUPERSEDED: { label: "Superseded", tone: "closed" },
  STALE: { label: "Stale", tone: "closed" },
};
export const reviewStateLabel = (state: ReviewState): string => STATES[state].label;
export const reviewStateTone = (state: ReviewState): ReviewTone => STATES[state].tone;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Stored instants render in UTC with one fixed English format, so every viewer sees the same text. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** The authorized members directory names the approver; an unlisted ID stays visible instead of a guessed name. */
export function approverLabel(approverId: string | null, directory: readonly DirectoryMember[] | null): string {
  if (!approverId) return "Not assigned";
  const member = directory?.find(entry => entry.profileId === approverId);
  return member ? `${member.displayName} · ${roleLabel(member.role)}` : `Member ${approverId}`;
}

export const decisionState = (decision: ReviewDecision["decision"]): ReviewState =>
  decision === "APPROVE" ? "APPROVED" : decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REJECTED";

/** Whether a captured flow or requirement is approved scope, in the exact words the reader shows. */
export function scopeNote(inclusion: Inclusion, approved: boolean): string {
  if (inclusion === "EXCLUDED") return "Excluded background. Not approved behavior.";
  if (inclusion === "UNDECIDED") return "Undecided / exploratory background. Not approved.";
  return approved ? "Included in approved scope." : "Included candidate scope. Not approved.";
}

/** Only an included link reviewed against its current endpoints is approved scope. */
export function linkNote(included: boolean, state: LinkState, approved: boolean): string {
  if (!included) return "Background trace link. Not approved.";
  if (state !== "CURRENT") return "Unreviewed included trace link. Not approved.";
  return approved ? "Reviewed included link. Approved scope." : "Reviewed included candidate link. Not approved.";
}

export const linkReviewLabel = (state: LinkState): string => state === "CURRENT" ? "Current" : state === "PROPOSED" ? "Not reviewed" : "Needs review";
