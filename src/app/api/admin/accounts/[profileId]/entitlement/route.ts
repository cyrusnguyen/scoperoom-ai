import { setEntitlement } from "@/features/admin/server/changes";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  return mutationRoute(request, (user, input) => setEntitlement(user, profileId, input));
}
