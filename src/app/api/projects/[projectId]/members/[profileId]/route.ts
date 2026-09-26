import { changeProjectMember, removeProjectMember } from "@/features/projects/server/management";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string; profileId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const { projectId, profileId } = await params;
  return mutationRoute(request, (user, input) => changeProjectMember(user, projectId, profileId, input));
}

export async function DELETE(request: Request, { params }: Context) {
  const { projectId, profileId } = await params;
  return mutationRoute(request, (user, input) => removeProjectMember(user, projectId, profileId, input));
}
