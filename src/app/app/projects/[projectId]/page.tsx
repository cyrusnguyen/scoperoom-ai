import { requireVerifiedUser } from "@/server/web/require-user";

export const dynamic = "force-dynamic";

// The shell in ../../layout.tsx renders the project (it reads the id with useParams); this page gates the route on the server.
export default async function ProjectPage() {
  await requireVerifiedUser();
  return null;
}
