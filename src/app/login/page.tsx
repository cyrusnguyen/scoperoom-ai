import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginView from "@/features/access/ui/login-view";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const metadata: Metadata = { title: "Sign in | ScopeRoom", robots: { index: false } };

type LoginPageProps = { searchParams: Promise<{ error?: string; code?: string; status?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (authConfig()) {
    const supabase = await createAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email_confirmed_at && !user.is_anonymous) redirect("/");
  }
  const { error, code, status } = await searchParams;
  if (code) redirect("/login?status=confirmed");
  const message = error === "invalid"
    ? "We could not sign you in. Check your email and password."
    : error === "unavailable" ? "Sign-in is temporarily unavailable. Please try again."
    : status === "confirmed" ? "Email confirmed. Sign in to continue." : null;

  return <LoginView message={message} isError={error === "invalid" || error === "unavailable"} />;
}