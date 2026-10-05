import type { SupabaseClient } from "@supabase/supabase-js";
import { safeInviteContinuation } from "./continuation.ts";

export type RecoveryInput = {
  email: string;
  code: string;
  password: string;
  confirmation: string;
  next: string | null;
};

export type RecoveryResult =
  | { kind: "invalid-input" }
  | { kind: "invalid-code" }
  | { kind: "unavailable" }
  | { kind: "new-code-required" }
  | { kind: "update-unknown" }
  | { kind: "updated" }
  | { kind: "updated-with-signout-warning" };

export type PasswordResetRequestResult = { kind: "invalid-input" | "accepted" | "unavailable" | "send-unknown" };

export type RecoveryClient = {
  auth: Pick<SupabaseClient["auth"], "resetPasswordForEmail" | "verifyOtp" | "updateUser" | "signOut"> &
    { admin: Pick<SupabaseClient["auth"]["admin"], "signOut"> };
};

export function normalizeRecoveryEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function validateRecoveryInput(value: unknown): RecoveryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid recovery input.");
  const input = value as Record<string, unknown>;
  const email = normalizeRecoveryEmail(input.email);
  if (!email || typeof input.code !== "string" || !/^[0-9]{6}$/.test(input.code)) throw new TypeError("Invalid recovery input.");
  if (typeof input.password !== "string" || input.password.length < 8 || input.password.length > 1024) throw new TypeError("Invalid recovery input.");
  if (typeof input.confirmation !== "string" || input.password !== input.confirmation) throw new TypeError("Invalid recovery input.");
  const next = input.next;
  if (next !== null && (typeof next !== "string" || safeInviteContinuation(next) !== next)) throw new TypeError("Invalid recovery input.");
  return { email, code: input.code, password: input.password, confirmation: input.confirmation, next };
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return null;
  return error.code;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return null;
  return error.status;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function confirmedUserId(value: unknown, email: string): string | null {
  const user = record(value);
  if (!user || typeof user.id !== "string" || !user.id || user.is_anonymous !== false || typeof user.email_confirmed_at !== "string" || !Number.isFinite(Date.parse(user.email_confirmed_at))) return null;
  return normalizeRecoveryEmail(user.email) === email ? user.id : null;
}

function matchingSession(value: unknown, userId: string, email: string): boolean {
  const session = record(value);
  return typeof session?.access_token === "string" && session.access_token.length > 0
    && typeof session.refresh_token === "string" && session.refresh_token.length > 0
    && typeof session.expires_in === "number" && Number.isFinite(session.expires_in) && session.expires_in > 0
    && (session.expires_at === undefined || (typeof session.expires_at === "number" && Number.isFinite(session.expires_at) && session.expires_at > 0))
    && session.token_type === "bearer" && confirmedUserId(session.user, email) === userId;
}

function explicitRefusal(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== null && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429
    && record(error)?.name !== "AuthRetryableFetchError";
}

async function signOutLocal(client: RecoveryClient) {
  try { await client.auth.signOut({ scope: "local" }); } catch { /* Preserve the original recovery result. */ }
}

export async function requestPasswordReset(client: RecoveryClient, rawEmail: unknown): Promise<PasswordResetRequestResult> {
  const email = normalizeRecoveryEmail(rawEmail);
  if (!email) return { kind: "invalid-input" };
  try {
    const response = record(await client.auth.resetPasswordForEmail(email));
    const error = response?.error;
    if (error === null && record(response?.data)) return { kind: "accepted" };
    if (errorCode(error) === "over_email_send_rate_limit" && errorStatus(error) === 429) return { kind: "accepted" };
    // A timeout, transport failure or unusable acknowledgement may follow a completed send.
    if (explicitRefusal(error) || errorStatus(error) === 429) return { kind: "unavailable" };
    return { kind: "send-unknown" };
  } catch {
    return { kind: "send-unknown" };
  }
}

export async function recoverPassword(client: RecoveryClient, rawInput: unknown): Promise<RecoveryResult> {
  let input: RecoveryInput;
  try { input = validateRecoveryInput(rawInput); } catch { return { kind: "invalid-input" }; }

  let verified: Awaited<ReturnType<RecoveryClient["auth"]["verifyOtp"]>>;
  try {
    verified = await client.auth.verifyOtp({ email: input.email, token: input.code, type: "recovery" });
  } catch {
    return { kind: "unavailable" };
  }

  const verifyResponse = record(verified);
  const verifyData = record(verifyResponse?.data);
  const verifyError = verifyResponse?.error;
  const session = verifyData?.session;
  if (verifyError) {
    if (session) await signOutLocal(client);
    const code = errorCode(verifyError);
    const status = errorStatus(verifyError);
    return code === "otp_expired" || status === 400 || status === 422 ? { kind: "invalid-code" } : { kind: "unavailable" };
  }

  const userId = confirmedUserId(verifyData?.user, input.email);
  if (verifyError !== null || !userId || !matchingSession(session, userId, input.email)) {
    if (session) await signOutLocal(client);
    return { kind: "invalid-code" };
  }

  let updated: Awaited<ReturnType<RecoveryClient["auth"]["updateUser"]>>;
  try {
    updated = await client.auth.updateUser({ password: input.password });
  } catch {
    await signOutLocal(client);
    return { kind: "update-unknown" };
  }

  const updateResponse = record(updated);
  const updateData = record(updateResponse?.data);
  const updateError = updateResponse?.error;
  if (updateError) {
    await signOutLocal(client);
    return explicitRefusal(updateError)
      ? { kind: "new-code-required" }
      : { kind: "update-unknown" };
  }

  const updatedUser = updateData?.user;
  const updateUserId = confirmedUserId(updatedUser, input.email);
  if (updateError !== null || updateUserId !== userId) {
    await signOutLocal(client);
    return { kind: "update-unknown" };
  }
  const updatedSession = updateData?.session;
  if (updatedSession && !matchingSession(updatedSession, userId, input.email)) {
    await signOutLocal(client);
    return { kind: "update-unknown" };
  }

  const accessToken = record(session)?.access_token;
  if (typeof accessToken !== "string") {
    await signOutLocal(client);
    return { kind: "update-unknown" };
  }
  try {
    const response = record(await client.auth.admin.signOut(accessToken, "global"));
    if (response?.error !== null) return { kind: "updated-with-signout-warning" };
  } catch {
    return { kind: "updated-with-signout-warning" };
  }
  return { kind: "updated" };
}