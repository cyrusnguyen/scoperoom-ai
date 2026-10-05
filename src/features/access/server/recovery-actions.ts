"use server";

import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";
import { identityFrom } from "@/server/web/identity";
import { clearPendingRecovery, getPendingRecovery, getRecoveryCooldown, setPendingRecovery } from "@/server/web/pending-recovery";
import { createRecoveryClient } from "@/server/web/recovery-client";
import { normalizeRecoveryEmail, recoverPassword as runRecovery, requestPasswordReset, validateRecoveryInput, type RecoveryResult } from "./password-recovery";
import { safeInviteContinuation } from "./continuation";

type GateResult = "anonymous" | "signed-in" | "unavailable";
type RecoveryActionsResult = RecoveryResult | { kind: "signed-in" };
export type RequestPasswordResetActionResult =
  | { kind: "invalid-input" | "signed-in" | "unavailable" | "send-unknown" | "accepted" }
  | { kind: "cooldown"; remainingSeconds: number };

async function identityGate(): Promise<GateResult> {
  if (!authConfig()) return "unavailable";
  try {
    const identity = await identityFrom(() => createAuthClient().then((client) => client.auth.getUser()));
    return identity.kind === "user" ? "signed-in" : identity.kind === "none" ? "anonymous" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function safeContinuation(formData: FormData): { ok: true; value: string | null } | { ok: false } {
  const raw = formData.get("continue");
  if (raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const value = safeInviteContinuation(raw);
  return value === raw ? { ok: true, value } : { ok: false };
}

function value(formData: FormData, name: string): unknown {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry : null;
}

export async function requestPasswordResetAction(formData: FormData): Promise<RequestPasswordResetActionResult> {
  const email = normalizeRecoveryEmail(value(formData, "email"));
  const next = safeContinuation(formData);
  if (!email || !next.ok) return { kind: "invalid-input" };

  const gate = await identityGate();
  if (gate !== "anonymous") return { kind: gate };

  let pending: Awaited<ReturnType<typeof getPendingRecovery>> = null;
  try { pending = await getPendingRecovery(); } catch { /* Provider limits remain authoritative if presentation state is unavailable. */ }
  if (pending && pending.email !== email) {
    try { await clearPendingRecovery(); } catch { /* Replaced after an accepted request when possible. */ }
  }
  let remainingSeconds = 0;
  try { remainingSeconds = await getRecoveryCooldown(email); } catch { /* Provider limits remain authoritative if presentation state is unavailable. */ }
  if (remainingSeconds > 0) return { kind: "cooldown", remainingSeconds };

  let result: Awaited<ReturnType<typeof requestPasswordReset>>;
  try { result = await requestPasswordReset(createRecoveryClient(), email); } catch { return { kind: "unavailable" }; }
  if (result.kind !== "accepted" && result.kind !== "send-unknown") return result;
  try { await setPendingRecovery(email); } catch { return { kind: "send-unknown" }; }
  return result;
}

export async function recoverPasswordAction(formData: FormData): Promise<RecoveryActionsResult> {
  const next = safeContinuation(formData);
  if (!next.ok) return { kind: "invalid-input" };
  let input;
  try {
    input = validateRecoveryInput({
      email: value(formData, "email"),
      code: value(formData, "code"),
      password: value(formData, "password"),
      confirmation: value(formData, "confirmation"),
      next: next.value,
    });
  } catch {
    return { kind: "invalid-input" };
  }

  const gate = await identityGate();
  if (gate !== "anonymous") return { kind: gate };

  let result: RecoveryResult;
  try { result = await runRecovery(createRecoveryClient(), input); } catch { return { kind: "unavailable" }; }
  if (result.kind === "updated" || result.kind === "updated-with-signout-warning") {
    try { await clearPendingRecovery(); } catch { /* Cookie state is presentation-only; preserve the confirmed password result. */ }
  }
  return result;
}

export async function changeRecoveryEmailAction(): Promise<{ kind: "ready" }> {
  await clearPendingRecovery();
  return { kind: "ready" };
}
