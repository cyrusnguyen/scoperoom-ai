import { WITHDRAW_BODY_LIMIT } from "@/features/reviews/contracts/review";
import { withdrawReview } from "@/features/reviews/server/reviews";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; reviewId: string }> }) {
  const { projectId, reviewId } = await params;
  return mutationRoute(request, (user, { key, ...body }) => withdrawReview(user, projectId, reviewId, body, key as string), { bodyLimit: WITHDRAW_BODY_LIMIT, limitDetails: { limit: "WITHDRAW_BODY" } });
}
