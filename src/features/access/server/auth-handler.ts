import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

type AuthResult = { ok: true } | { ok: false; reason: "invalid" | "unavailable" | "unconfirmed" | "rate-limited" };

type SignUpDetails = { email: string; password: string; name: string; emailRedirectTo: string };

// Keep provider operations behind one request-scoped contract; routes never own Supabase calls.
export interface AuthHandler {
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(details: SignUpDetails): Promise<AuthResult>;
  verifyEmail(email: string, code: string): Promise<AuthResult>;
  resendCode(email: string, emailRedirectTo: string): Promise<AuthResult>;
}

export function createAuthHandler(supabase: SupabaseClient): AuthHandler {
  return {
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return { ok: true };
      if (error.code === "email_not_confirmed") return { ok: false, reason: "unconfirmed" };
      return { ok: false, reason: [400, 422].includes(error.status ?? 0) ? "invalid" : "unavailable" };
    },
    async signUp({ email, password, name, emailRedirectTo }) {
      const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo, data: { full_name: name } } });
      if (!error) return { ok: true };
      if (error.status === 429) return { ok: false, reason: "rate-limited" };
      return { ok: false, reason: [400, 422].includes(error.status ?? 0) ? "invalid" : "unavailable" };
    },
    async verifyEmail(email, code) {
      const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
      if (!error && data.user?.email_confirmed_at) return { ok: true };
      return { ok: false, reason: !error || error.code === "otp_expired" || [400, 422].includes(error.status ?? 0) ? "invalid" : "unavailable" };
    },
    async resendCode(email, emailRedirectTo) {
      const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo } });
      if (!error) return { ok: true };
      if (error.status === 429) return { ok: false, reason: "rate-limited" };
      return { ok: false, reason: [400, 422].includes(error.status ?? 0) ? "invalid" : "unavailable" };
    },
  };
}
