import "server-only";
import { redirect } from "next/navigation";
import { authConfig } from "./auth-config.ts";
import { classifyIdentity } from "./identity.ts";
import { createAuthClient } from "./supabase.ts";

/** Server page gate: verified identity, sign-in/verification redirect, or null when Auth is unavailable. */
export async function requireVerifiedUser() {
  if (!authConfig()) redirect("/login");
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser().catch((error: unknown) => ({ data: { user: null }, error }));
  if (!error && user && (!user.email_confirmed_at || user.is_anonymous)) redirect("/signup/verify");
  const identity = classifyIdentity({ user, error });
  if (identity.kind === "unavailable") return null;
  if (identity.kind === "none") redirect("/login");
  return identity.user;
}

/** For the signed-out pages: true only for a confirmed, non-anonymous session; false without Auth configuration. An outage may throw. */
export async function hasVerifiedSession() {
  if (!authConfig()) return false;
  const { data: { user } } = await (await createAuthClient()).auth.getUser();
  return Boolean(user?.email_confirmed_at && !user.is_anonymous);
}
