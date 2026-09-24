"use server";

import { redirect } from "next/navigation";
import { confirmationRedirectUrl } from "@/server/env";
import { createAuthHandler } from "@/features/access/server/auth-handler";
import { RESEND_COOLDOWN_SECONDS, secondsRemaining } from "@/features/access/verification-policy";
import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { clearPendingEmail, getCodeSentAt, getPendingEmail, markCodeSent, setPendingEmail } from "@/server/web/pending-email";

function emailField(formData: FormData) {
  const value = formData.get("email");
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 320 ? email : null;
}

export async function signIn(formData: FormData) {
  const email = emailField(formData);
  const password = formData.get("password");
  if (!email || typeof password !== "string" || !password || password.length > 1024) redirect("/login?error=invalid");
  if (!authConfig()) redirect("/login?error=unavailable");

  const result = await createAuthHandler(await createAuthClient()).signIn(email, password);
  if (!result.ok) {
    if (result.reason === "unconfirmed") {
      await setPendingEmail(email);
      redirect("/signup/verify?status=pending");
    }
    redirect(`/login?error=${result.reason}`);
  }
  await clearPendingEmail();
  redirect("/");
}

export async function signUp(formData: FormData) {
  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  const email = emailField(formData);
  const password = formData.get("password");
  const confirmation = formData.get("confirmPassword");
  if (!name || name.length > 80 || !email || typeof password !== "string" || password.length < 8 || password.length > 1024 || password !== confirmation) {
    redirect("/signup?error=invalid");
  }
  if (!authConfig()) redirect("/signup?error=unavailable");

  const result = await createAuthHandler(await createAuthClient()).signUp({ email, password, name, emailRedirectTo: confirmationRedirectUrl() });
  if (!result.ok) redirect(`/signup?error=${result.reason}`);
  await setPendingEmail(email);
  await markCodeSent(email);
  redirect("/signup/verify?status=sent");
}

export async function verifyEmailCode(formData: FormData) {
  const email = await getPendingEmail();
  const code = formData.get("code");
  if (!email) redirect("/signup");
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) redirect("/signup/verify?error=invalid");
  if (!authConfig()) redirect("/signup/verify?error=unavailable");

  const result = await createAuthHandler(await createAuthClient()).verifyEmail(email, code);
  if (!result.ok) redirect(`/signup/verify?error=${result.reason}`);
  await clearPendingEmail();
  redirect("/");
}

export async function resendVerificationCode() {
  const email = await getPendingEmail();
  if (!email) redirect("/signup");
  if (!authConfig()) redirect("/signup/verify?error=unavailable");
  const sentAt = await getCodeSentAt(email);
  if (secondsRemaining(sentAt, RESEND_COOLDOWN_SECONDS, Date.now()) > 0) {
    redirect("/signup/verify?error=cooldown");
  }

  const result = await createAuthHandler(await createAuthClient()).resendCode(email, confirmationRedirectUrl());
  if (!result.ok) redirect(`/signup/verify?error=${result.reason}`);
  await setPendingEmail(email);
  await markCodeSent(email);
  redirect("/signup/verify?status=resent");
}

export async function changeVerificationEmail() {
  await clearPendingEmail();
  redirect("/signup");
}

export async function signOut() {
  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error("Could not sign out. Please try again.");
  await clearPendingEmail();
  redirect("/login");
}
