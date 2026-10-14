import { readAccount } from "@/features/admin/server/accounts";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  return readRoute(request, (user) => readAccount(user, profileId));
}
