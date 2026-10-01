import { readProcessEnv } from "../../server/env.ts";

/** Supabase session cookies: never readable by page scripts; Secure whenever the app is served over HTTPS. */
export function sessionCookieOptions(values: Partial<NodeJS.ProcessEnv> = process.env) {
  const { appUrl } = readProcessEnv(values);
  return { httpOnly: true as const, sameSite: "lax" as const, secure: Boolean(appUrl?.startsWith("https://")), path: "/" as const };
}
