import { getFlowImport } from "@/features/exchange/server/import-flow";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; previewId: string }> }) {
  const { projectId, previewId } = await params;
  return readRoute(request, (identity) => getFlowImport(identity, projectId, previewId));
}
