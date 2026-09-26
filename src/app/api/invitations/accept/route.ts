import { acceptInvitation } from "@/features/projects/server/invitations";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return mutationRoute(request, acceptInvitation, { createdStatus: 201 });
}
