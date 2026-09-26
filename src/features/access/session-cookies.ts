/** Supabase session cookies: never readable by page scripts; Secure whenever the app is served over HTTPS. */
export function sessionCookieOptions(appUrl: string | undefined) {
  return { httpOnly: true as const, sameSite: "lax" as const, secure: Boolean(appUrl?.startsWith("https://")), path: "/" as const };
}
