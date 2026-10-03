import "server-only";
import { redirect } from "next/navigation";
import { authConfig } from "./auth-config.ts";
import { classifyIdentity } from "./identity.ts";
import { createAuthClient } from "./supabase.ts";

/** Server page gate: verified user, sign-in/verification redirect, or null when Auth is unavailable. */
export async function requireVerifiedUser() {
  if (!authConfig()) redirect("/login");
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser().catch((error: unknown) => ({ data: { user: null }, error }));
  if (!error && user && (!user.email_confirmed_at || user.is_anonymous)) redirect("/signup/verify");
  const identity = classifyIdentity({ user, error });
  if (identity.kind === "unavailable") return null;
  if (identity.kind === "none") redirect("/login");
  return user;
}
