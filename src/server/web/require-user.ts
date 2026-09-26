import "server-only";
import { redirect } from "next/navigation";
import { authConfig } from "./auth-config.ts";
import { createAuthClient } from "./supabase.ts";

/** Server gate for signed-in pages: a confirmed, non-anonymous Supabase user, or a redirect to sign-in or verification. */
export async function requireVerifiedUser() {
  if (!authConfig()) redirect("/login");
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  if (!user.email_confirmed_at || user.is_anonymous) redirect("/signup/verify");
  return user;
}
