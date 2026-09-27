import { requireVerifiedUser } from "@/server/web/require-user";

export const dynamic = "force-dynamic";

// The shell in ./layout.tsx renders the UI; this page gates the route on the server.
export default async function AppPage() {
  await requireVerifiedUser();
  return null;
}
