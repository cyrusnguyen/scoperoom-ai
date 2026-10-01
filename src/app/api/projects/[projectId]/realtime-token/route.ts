import { issueRealtimeToken } from "@/features/collaboration/server/realtime-token";
import { credentialRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return credentialRoute(request, (user) => issueRealtimeToken(user, projectId));
}
