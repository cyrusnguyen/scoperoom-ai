import type { Inclusion } from "@/features/drafts/contracts/scope-document";
import { INCLUSION_LABELS } from "@/features/studio/ui/fields";
import type { ReviewState } from "../contracts/review";
import { reviewStateLabel, reviewStateTone } from "./review-format";

/** A review outcome as words on a token-coloured chip (review.css tones). */
export function ReviewStateBadge({ state }: { state: ReviewState }) {
  return <span className="badge review-state" data-tone={reviewStateTone(state)}>{reviewStateLabel(state)}</span>;
}

/** The same inclusion chip the Studio header shows (studio.css), so scope reads alike everywhere. */
export function InclusionBadge({ inclusion }: { inclusion: Inclusion }) {
  return <span className="badge" data-inclusion={inclusion}>{INCLUSION_LABELS[inclusion]}</span>;
}
