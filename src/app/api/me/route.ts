import { getMe } from "@/features/access/server/me";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return readRoute(request, getMe);
}
