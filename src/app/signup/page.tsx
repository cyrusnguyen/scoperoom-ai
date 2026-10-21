import type { Metadata } from "next";
import { redirect } from "next/navigation";
import SignupView from "@/features/access/ui/signup-view";
import { safeInviteContinuation } from "@/features/access/server/continuation";
import { hasVerifiedSession } from "@/server/web/require-user";

export const metadata: Metadata = { title: "Sign up | ScopeRoom", robots: { index: false } };

type SignupPageProps = { searchParams: Promise<{ error?: string; continue?: string }> };

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const { error, continue: rawContinuation } = await searchParams;
  const continuation = safeInviteContinuation(rawContinuation);
  if (await hasVerifiedSession()) redirect(continuation ?? "/app");
  const message = error === "invalid" ? "Check your details and try again." :
    error === "rate-limited" ? "Too many emails were requested. Please wait before trying again." :
    error === "unavailable" ? "Sign-up is temporarily unavailable. Please try again." : null;
  return <SignupView message={message} continuation={continuation} />;
}