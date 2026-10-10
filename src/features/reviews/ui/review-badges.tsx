import type { ReviewState } from "../contracts/review";
import { reviewStateLabel, reviewStateTone } from "./review-format";

/** A review outcome as words on a token-coloured chip (review.css tones). */
export function ReviewStateBadge({ state }: { state: ReviewState }) {
  return <span className="badge review-state" data-tone={reviewStateTone(state)}>{reviewStateLabel(state)}</span>;
}
