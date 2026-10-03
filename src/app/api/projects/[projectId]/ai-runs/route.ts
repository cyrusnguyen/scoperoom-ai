import { AI_LIMITS } from "@/features/proposals/contracts/tasks";
import { startRun } from "@/features/proposals/server/admit-run";
import { listRuns } from "@/features/proposals/server/read-runs";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const query = new URL(request.url).searchParams;
  return readRoute(request, (user) => listRuns(user, projectId, { cursor: query.get("cursor") ?? undefined, flowId: query.get("flowId") ?? undefined }));
}

/** 202 only after the admission transaction committed; a same-key retry (200) returns the same durable run. */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return mutationRoute(request, (user, input) => startRun(user, projectId, input), { createdStatus: 202, bodyLimit: AI_LIMITS.startBodyBytes, limitDetails: { limit: "START_BODY_BYTES" } });
}
