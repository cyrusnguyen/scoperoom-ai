import { isAuthApiError, isAuthSessionMissingError, type User } from "@supabase/supabase-js";

export type VerifiedIdentity = { authUserId: string; displayName: string; verifiedEmail: string };
/** `none` is a definitive denial (401); `unavailable` is a provider outage that must never authorize (503). */
export type IdentityResult = { kind: "user"; user: VerifiedIdentity } | { kind: "none" } | { kind: "unavailable" };

// Only an explicit client-side Auth denial is definitive. Session missing and 4xx API errors (except timeout and throttling)
// mean the caller is not signed in; transport failures, 5xx, 408/429, refresh races and anything unrecognized are outages.
function denies(error: unknown) {
  return isAuthSessionMissingError(error) || (isAuthApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
}

export function classifyIdentity({ user, error }: { user: User | null; error: unknown }): IdentityResult {
  if (error) return denies(error) ? { kind: "none" } : { kind: "unavailable" };
  if (!user || !user.email_confirmed_at || user.is_anonymous || typeof user.email !== "string") return { kind: "none" };
  const rawName = user.user_metadata.full_name;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  const fallback = user.email.split("@")[0]!.slice(0, 80);
  return { kind: "user", user: { authUserId: user.id, displayName: name && name.length <= 80 ? name : fallback, verifiedEmail: user.email.normalize("NFC").trim().toLowerCase() } };
}

/** Runs the provider lookup; a thrown error is classified like a returned one. */
export async function identityFrom(getUser: () => Promise<{ data: { user: User | null }; error: unknown }>): Promise<IdentityResult> {
  try {
    const { data, error } = await getUser();
    return classifyIdentity({ user: data.user, error });
  } catch (error) {
    return classifyIdentity({ user: null, error });
  }
}
