import { previewFlowImport } from "@/features/exchange/server/import-flow";
import { nativeUploadRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const draftId = new URL(request.url).searchParams.get("draftId") ?? "";
  const previewId = new URL(request.url).searchParams.get("previewId") ?? "";
  return nativeUploadRoute(request, (identity, bytes, key) => previewFlowImport(identity, projectId, draftId, previewId, key, bytes));
}
