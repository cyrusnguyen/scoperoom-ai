import type { Metadata } from "next";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { changeRecoveryEmailAction, recoverPasswordAction, requestPasswordResetAction } from "@/features/access/server/recovery-actions";
import { getPendingRecovery } from "@/server/web/pending-recovery";
import RecoverySignedInView from "@/features/access/ui/recovery-signed-in-view";
import ResetPasswordView from "@/features/access/ui/reset-password-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reset password | ScopeRoom", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ continue?: string; status?: string; error?: string }> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  const { continue: rawContinuation, status: rawStatus, error: rawError } = await searchParams;
  const continuation = safeInviteContinuation(rawContinuation);
  let signedIn = false;
  if (authConfig()) {
    try {
      const { data: { user } } = await (await createAuthClient()).auth.getUser();
      signedIn = Boolean(user?.email_confirmed_at && !user.is_anonymous);
    } catch { /* Mutating actions remain closed when trusted identity cannot be read. */ }
  }
  if (signedIn) return <RecoverySignedInView continuation={continuation} />;
  const pending = await getPendingRecovery().catch(() => null);
  const status = rawStatus === "sent" || rawStatus === "send-unknown" ? rawStatus : null;
  const error = rawError === "unavailable" || rawError === "cooldown" ? rawError : null;
  return <ResetPasswordView email={pending?.email ?? null} sentAt={pending?.sentAt ?? null} status={status} error={error} continuation={continuation} recoverAction={recoverPasswordAction} requestAction={requestPasswordResetAction} changeEmailAction={changeRecoveryEmailAction} />;
}
