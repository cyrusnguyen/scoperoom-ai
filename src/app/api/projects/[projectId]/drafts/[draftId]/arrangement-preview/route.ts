import { previewArrangement } from "@/features/drafts/server/positions";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

// Nonmutating: same-origin and authenticated like a mutation, but it saves nothing, so it takes no Idempotency-Key.
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return mutationRoute(request, (user, input) => previewArrangement(user, projectId, draftId, input), { keyless: true });
}
