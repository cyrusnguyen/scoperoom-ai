import { applyFlowImport } from "@/features/exchange/server/import-flow";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; previewId: string }> }) {
  const { projectId, previewId } = await params;
  return mutationRoute(request, (identity, input) => applyFlowImport(identity, projectId, previewId, input as { key: string; draftId: string; previewHash: string }));
}
