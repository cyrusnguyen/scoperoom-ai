import { requireVerifiedUser } from "@/server/web/require-user";
import { PageAccess } from "@/features/access/ui/page-access";

export const dynamic = "force-dynamic";

// The shell in ./layout.tsx renders the UI; this page gates the route on the server.
export default async function AppPage() {
  const user = await requireVerifiedUser();
  return <PageAccess available={Boolean(user)} />;
}
