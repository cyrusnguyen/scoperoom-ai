import { decideReview } from "@/features/reviews/server/reviews";
import { DECISION_BODY_LIMIT } from "@/features/reviews/contracts/review";
import { mutationRoute } from "@/server/web/api-request";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; reviewId: string }> }) {
  const { projectId, reviewId } = await params;
  return mutationRoute(request, (user, input) => {
    const { key, ...body } = input;
    return decideReview(user, projectId, reviewId, body, key as string);
  }, { bodyLimit: DECISION_BODY_LIMIT, limitDetails: { limit: "DECISION_BODY" } });
}
