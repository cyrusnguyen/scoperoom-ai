import { setRole } from "@/features/admin/server/changes";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  return mutationRoute(request, (user, input) => setRole(user, profileId, input));
}
