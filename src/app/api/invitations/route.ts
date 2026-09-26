import { listMyInvitations } from "@/features/projects/server/invitations";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return readRoute(request, listMyInvitations);
}
