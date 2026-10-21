import type { Metadata } from "next";
import { hasVerifiedSession } from "@/server/web/require-user";
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
  // An outage reads as signed out here; the actions still require a trusted anonymous identity before sending.
  if (await hasVerifiedSession().catch(() => false)) return <RecoverySignedInView continuation={continuation} />;
  return <ForgotPasswordView continuation={continuation} requestAction={requestPasswordResetAction} />;
}
