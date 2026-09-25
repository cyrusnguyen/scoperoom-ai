import type { Metadata } from "next";
import { redirect } from "next/navigation";
import InviteAcceptance from "@/features/access/ui/invite-acceptance";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { signOut } from "@/features/access/server/actions";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const metadata: Metadata = { title: "Invitation | ScopeRoom", robots: { index: false } };

type InvitePageProps = { params: Promise<{ token: string }> };

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const continuation = safeInviteContinuation(`/invite/${token}`);
  if (!continuation) redirect("/login");
  if (!authConfig()) redirect("/login");
  const supabase = await createAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email_confirmed_at || user.is_anonymous) redirect(`/login?continue=${encodeURIComponent(continuation)}`);
  return <InviteAcceptance token={token} signOut={signOut} />;
}