import { redirect } from "next/navigation";
import { signOut } from "@/features/access/server/actions";
import BlankWorkspace from "@/features/workspace/ui/blank-workspace";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!authConfig()) redirect("/login");
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  if (!user.email_confirmed_at || user.is_anonymous) redirect("/signup/verify");
  const { projectId } = await params;
  return <BlankWorkspace signOut={signOut} projectId={projectId} />;
}