import { SOURCE_BODY_LIMIT } from "@/features/sources/contracts/source-version";
import { createSource, listSources } from "@/features/sources/server/sources";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const query = new URL(request.url).searchParams;
  return readRoute(request, (user) => listSources(user, projectId, { scope: query.get("scope") ?? undefined, cursor: query.get("cursor") ?? undefined }));
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return mutationRoute(request, (user, input) => createSource(user, projectId, input), { createdStatus: 201, bodyLimit: SOURCE_BODY_LIMIT, limitDetails: { limit: "SOURCE_BODY_BYTES" } });
}
