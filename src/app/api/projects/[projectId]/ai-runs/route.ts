import { AI_LIMITS } from "@/features/proposals/contracts/tasks";
import { startRun } from "@/features/proposals/server/admit-run";
import { dispatchAi } from "@/features/proposals/server/dispatch-ai";
import { jobDispatcher } from "@/features/proposals/server/providers";
import { listRuns } from "@/features/proposals/server/read-runs";
import { getDatabase } from "@/server/db";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const query = new URL(request.url).searchParams;
  return readRoute(request, (user) => listRuns(user, projectId, { cursor: query.get("cursor") ?? undefined, flowId: query.get("flowId") ?? undefined }));
}

/**
 * Best-effort fast path after the admission commit. With no configured dispatcher (CI, e2e) the run simply stays PENDING for repair; any
 * failure or slow provider is ignored, because the committed run is the durable intent and never depends on this call.
 */
async function dispatchFastPath(runId: string) {
  const dispatcher = jobDispatcher();
  if (!dispatcher) return;
  try {
    await Promise.race([dispatchAi(runId, dispatcher, await getDatabase()), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  } catch {
    // PENDING stays; repair delivers it.
  }
}

/** 202 only after the admission transaction committed; a same-key retry (200) returns the same durable run. */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return mutationRoute(request, async (user, input) => {
    const started = await startRun(user, projectId, input);
    await dispatchFastPath(started.runId);
    return started;
  }, { createdStatus: 202, bodyLimit: AI_LIMITS.startBodyBytes, limitDetails: { limit: "START_BODY_BYTES" } });
}
