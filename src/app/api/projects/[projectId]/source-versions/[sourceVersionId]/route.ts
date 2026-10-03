import { readSourceVersion } from "@/features/sources/server/source-versions";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; sourceVersionId: string }> }) {
  const { projectId, sourceVersionId } = await params;
  return readRoute(request, (user) => readSourceVersion(user, projectId, sourceVersionId));
}
