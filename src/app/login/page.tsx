import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginView from "@/features/access/ui/login-view";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const metadata: Metadata = { title: "Sign in | ScopeRoom", robots: { index: false } };

type LoginPageProps = { searchParams: Promise<{ error?: string; code?: string; status?: string; continue?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, code, status, continue: rawContinuation } = await searchParams;
  const continuation = safeInviteContinuation(rawContinuation);
  if (authConfig()) {
    const supabase = await createAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email_confirmed_at && !user.is_anonymous) redirect(continuation ?? "/");
  }
  if (code) redirect(`/login?status=confirmed${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`);
  const message = error === "invalid"
    ? "We could not sign you in. Check your email and password."
    : error === "unavailable" ? "Sign-in is temporarily unavailable. Please try again."
    : status === "confirmed" ? "Email confirmed. Sign in to continue." : null;

  return <LoginView message={message} isError={error === "invalid" || error === "unavailable"} continuation={continuation} />;
}