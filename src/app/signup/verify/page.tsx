import type { Metadata } from "next";
import { redirect } from "next/navigation";
import VerifyView from "@/features/access/ui/verify-view";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { getCodeSentAt, getPendingEmail } from "@/server/web/pending-email";

export const metadata: Metadata = { title: "Verify email | ScopeRoom", robots: { index: false } };

type VerifyPageProps = { searchParams: Promise<{ error?: string; status?: string; continue?: string }> };

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const { error, status, continue: rawContinuation } = await searchParams;
  const continuation = safeInviteContinuation(rawContinuation);
  if (authConfig()) {
    const supabase = await createAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email_confirmed_at && !user.is_anonymous) redirect(continuation ?? "/");
  }
  const email = await getPendingEmail();
  if (!email) redirect(`/signup${continuation ? `?continue=${encodeURIComponent(continuation)}` : ""}`);
  const message = error === "invalid" ? "The code is invalid or expired. Try again or request a new code." :
    error === "cooldown" ? "Wait for the resend timer before requesting another code." :
    error === "rate-limited" ? "Too many emails were requested. Please wait before trying again." :
    error === "unavailable" ? "Verification is temporarily unavailable. Please try again." :
    status === "sent" ? "If this address needs confirmation, check your email for a code. Already verified? Sign in instead." :
    status === "pending" ? "Confirm your email before signing in. Enter the code from your email." :
    status === "resent" ? "If the account is pending, a new code is on its way." : null;
  const sentAt = await getCodeSentAt(email);
  return <VerifyView email={email} sentAt={sentAt} message={message} isError={Boolean(error)} continuation={continuation} />;
}