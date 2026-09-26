"use server";

import { redirect } from "next/navigation";
import { confirmationRedirectUrl } from "@/server/env";
import { createAuthHandler } from "@/features/access/server/auth-handler";
import { RESEND_COOLDOWN_SECONDS, secondsRemaining } from "@/features/access/verification-policy";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { clearPendingEmail, getCodeSentAt, getPendingEmail, markCodeSent, setPendingEmail } from "@/server/web/pending-email";
import { safeInviteContinuation, withContinuation } from "./continuation";

function emailField(formData: FormData) {
  const value = formData.get("email");
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 320 ? email : null;
}

function verifyPath(status: string, continuation: string | null) {
  return `/signup/verify?${status}${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`;
}

export async function signIn(formData: FormData) {
  const email = emailField(formData);
  const password = formData.get("password");
  const continuation = safeInviteContinuation(formData.get("continue"));
  if (!email || typeof password !== "string" || !password || password.length > 1024) redirect(withContinuation("/login?error=invalid", continuation));
  if (!authConfig()) redirect(withContinuation("/login?error=unavailable", continuation));

  const result = await createAuthHandler(await createAuthClient()).signIn(email, password);
  if (!result.ok) {
    if (result.reason === "unconfirmed") {
      await setPendingEmail(email);
      redirect(verifyPath("status=pending", continuation));
    }
    redirect(withContinuation(`/login?error=${result.reason}`, continuation));
  }
  await clearPendingEmail();
  redirect(continuation ?? "/");
}

export async function signUp(formData: FormData) {
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  const email = emailField(formData);
  const password = formData.get("password");
  const confirmation = formData.get("confirmPassword");
  const continuation = safeInviteContinuation(formData.get("continue"));
  if (!name || name.length > 80 || !email || typeof password !== "string" || password.length < 8 || password.length > 1024 || password !== confirmation) {
    redirect(withContinuation("/signup?error=invalid", continuation));
  }
  if (!authConfig()) redirect(withContinuation("/signup?error=unavailable", continuation));

  const result = await createAuthHandler(await createAuthClient()).signUp({ email, password, name, emailRedirectTo: confirmationRedirectUrl() });
  if (!result.ok) redirect(withContinuation(`/signup?error=${result.reason}`, continuation));
  await setPendingEmail(email);
  await markCodeSent(email);
  redirect(verifyPath("status=sent", continuation));
}

export async function verifyEmailCode(formData: FormData) {
  const email = await getPendingEmail();
  const code = formData.get("code");
  const continuation = safeInviteContinuation(formData.get("continue"));
  if (!email) redirect(withContinuation("/signup", continuation));
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) redirect(verifyPath("error=invalid", continuation));
  if (!authConfig()) redirect(verifyPath("error=unavailable", continuation));

  const result = await createAuthHandler(await createAuthClient()).verifyEmail(email, code);
  if (!result.ok) redirect(verifyPath(`error=${result.reason}`, continuation));
  await clearPendingEmail();
  redirect(continuation ?? "/");
}

export async function resendVerificationCode(formData: FormData) {
  const email = await getPendingEmail();
  const continuation = safeInviteContinuation(formData.get("continue"));
  if (!email) redirect(withContinuation("/signup", continuation));
  if (!authConfig()) redirect(verifyPath("error=unavailable", continuation));
  const sentAt = await getCodeSentAt(email);
  if (secondsRemaining(sentAt, RESEND_COOLDOWN_SECONDS, Date.now()) > 0) {
    redirect(verifyPath("error=cooldown", continuation));
  }

  const result = await createAuthHandler(await createAuthClient()).resendCode(email, confirmationRedirectUrl());
  if (!result.ok) redirect(verifyPath(`error=${result.reason}`, continuation));
  await setPendingEmail(email);
  await markCodeSent(email);
  redirect(verifyPath("status=resent", continuation));
}

export async function changeVerificationEmail(formData: FormData) {
  const continuation = safeInviteContinuation(formData.get("continue"));
  await clearPendingEmail();
  redirect(withContinuation("/signup", continuation));
}

export async function signOut(formData?: FormData) {
  const continuation = safeInviteContinuation(formData?.get("continue"));
  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error("Could not sign out. Please try again.");
  await clearPendingEmail();
  redirect(withContinuation("/login", continuation));
}