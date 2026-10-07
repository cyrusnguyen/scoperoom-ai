import { SOURCE_BODY_LIMIT } from "@/features/sources/contracts/source-version";
import { correctSource, listSourceVersions } from "@/features/sources/server/sources";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; sourceId: string }> }) {
  const { projectId, sourceId } = await params;
  return readRoute(request, (user) => listSourceVersions(user, projectId, sourceId, new URL(request.url).searchParams.get("cursor") ?? undefined));
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; sourceId: string }> }) {
  const { projectId, sourceId } = await params;
  return mutationRoute(request, (user, input) => correctSource(user, projectId, sourceId, input), { createdStatus: 201, bodyLimit: SOURCE_BODY_LIMIT, limitDetails: { limit: "SOURCE_BODY_BYTES" } });
}
