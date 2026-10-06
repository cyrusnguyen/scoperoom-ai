import "server-only";
import { cookies } from "next/headers";
import { normalizeRecoveryEmail } from "@/features/access/server/password-recovery";
import { CODE_VALIDITY_SECONDS, RESEND_COOLDOWN_SECONDS, secondsRemaining } from "@/features/access/verification-policy";
import { sessionCookieOptions } from "@/features/access/session-cookies";

const COOKIE_NAME = "scoperoom.pending-recovery";
const COOKIE_PATH = "/forgot-password";
const COOKIE_MAX_AGE = CODE_VALIDITY_SECONDS;

export type PendingRecovery = { email: string; sentAt: number };

export async function getPendingRecovery(): Promise<PendingRecovery | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value || value.length > 600) return null;
  try {
    const state = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { email?: unknown; sentAt?: unknown };
    const email = normalizeRecoveryEmail(state.email);
    const sentAt = state.sentAt;
    if (!email || typeof sentAt !== "number" || !Number.isSafeInteger(sentAt) || sentAt <= 0 || sentAt > Date.now()) return null;
    if (secondsRemaining(sentAt, COOKIE_MAX_AGE, Date.now()) === 0) return null;
    return { email, sentAt };
  } catch {
    return null;
  }
}

export async function setPendingRecovery(emailValue: string, sentAt = Date.now()): Promise<void> {
  const email = normalizeRecoveryEmail(emailValue);
  if (!email || !Number.isSafeInteger(sentAt) || sentAt <= 0 || sentAt > Date.now()) throw new TypeError("Invalid recovery presentation state.");
  const value = Buffer.from(JSON.stringify({ email, sentAt })).toString("base64url");
  (await cookies()).set(COOKIE_NAME, value, {
    ...sessionCookieOptions(),
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function getRecoveryCooldown(emailValue: string, now = Date.now()): Promise<number> {
  const email = normalizeRecoveryEmail(emailValue);
  const pending = await getPendingRecovery();
  return email && pending?.email === email ? secondsRemaining(pending.sentAt, RESEND_COOLDOWN_SECONDS, now) : 0;
}

export async function clearPendingRecovery(): Promise<void> {
  const options = { ...sessionCookieOptions(), path: COOKIE_PATH, maxAge: 0 };
  (await cookies()).set(COOKIE_NAME, "", options);
}
