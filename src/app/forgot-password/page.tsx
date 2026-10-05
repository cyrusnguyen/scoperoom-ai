import type { Metadata } from "next";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { requestPasswordResetAction } from "@/features/access/server/recovery-actions";
import ForgotPasswordView from "@/features/access/ui/forgot-password-view";
import RecoverySignedInView from "@/features/access/ui/recovery-signed-in-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Forgot password | ScopeRoom", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ continue?: string }> };

export default async function ForgotPasswordPage({ searchParams }: Props) {
  const { continue: rawContinuation } = await searchParams;
  const continuation = safeInviteContinuation(rawContinuation);
  let signedIn = false;
  if (authConfig()) {
    try {
      const { data: { user } } = await (await createAuthClient()).auth.getUser();
      signedIn = Boolean(user?.email_confirmed_at && !user.is_anonymous);
    } catch { /* Actions still require a trusted anonymous identity before sending. */ }
  }
  if (signedIn) return <RecoverySignedInView />;
  return <ForgotPasswordView continuation={continuation} requestAction={requestPasswordResetAction} />;
}
