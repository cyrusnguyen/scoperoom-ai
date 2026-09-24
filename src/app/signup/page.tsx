import type { Metadata } from "next";
import { redirect } from "next/navigation";
import SignupView from "@/features/access/ui/signup-view";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const metadata: Metadata = { title: "Sign up | ScopeRoom", robots: { index: false } };

type SignupPageProps = { searchParams: Promise<{ error?: string }> };

export default async function SignupPage({ searchParams }: SignupPageProps) {
  if (authConfig()) {
    const supabase = await createAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email_confirmed_at && !user.is_anonymous) redirect("/");
  }
  const { error } = await searchParams;
  const message = error === "invalid" ? "Check your details and try again." :
    error === "rate-limited" ? "Too many emails were requested. Please wait before trying again." :
    error === "unavailable" ? "Sign-up is temporarily unavailable. Please try again." : null;
  return <SignupView message={message} />;
}
