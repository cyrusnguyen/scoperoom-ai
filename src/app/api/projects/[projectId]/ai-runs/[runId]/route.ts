import { readRun } from "@/features/proposals/server/read-runs";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;
  return readRoute(request, (user) => readRun(user, projectId, runId));
}
