import { ProjectError } from "@/features/projects/server/errors";
import { parseDiscardRunInput } from "@/features/proposals/contracts/tasks";
import { discardRun } from "@/features/proposals/server/discard-run";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;
  return mutationRoute(request, (user, input) => {
    const { key, ...body } = input;
    let parsed;
    try { parsed = parseDiscardRunInput(body, String(key)); } catch { throw new ProjectError("INVALID_INPUT"); }
    return discardRun(user, projectId, runId, parsed);
  }, { bodyLimit: 16 * 1024, limitDetails: { limit: "DISCARD_BODY_BYTES" } });
}
