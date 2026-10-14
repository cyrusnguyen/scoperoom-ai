import { listAccounts } from "@/features/admin/server/accounts";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  return readRoute(request, (user) => listAccounts(user, { query: query.get("q") ?? undefined, cursor: query.get("cursor") ?? undefined }));
}
