import { readSnapshot } from "@/features/reviews/server/read-reviews";
import { readRoute } from "@/server/web/api-request";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; snapshotId: string }> }) {
  const { projectId, snapshotId } = await params;
  return readRoute(request, user => readSnapshot(user, projectId, snapshotId));
}
