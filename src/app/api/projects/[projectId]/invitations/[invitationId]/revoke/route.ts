import { revokeInvitation } from "@/features/projects/server/invitations";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; invitationId: string }> }) {
  const { projectId, invitationId } = await params;
  return mutationRoute(request, (user, input) => revokeInvitation(user, projectId, invitationId, input));
}
