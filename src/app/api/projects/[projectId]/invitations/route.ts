import { issueInvitation, listProjectInvitations } from "@/features/projects/server/invitations";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { projectId } = await params;
  return readRoute(request, (user) => listProjectInvitations(user, projectId));
}

export async function POST(request: Request, { params }: Context) {
  const { projectId } = await params;
  return mutationRoute(request, (user, input) => issueInvitation(user, projectId, input), { createdStatus: 201 });
}
