import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sessionCookieOptions } from "@/features/access/session-cookies";
import { authConfig } from "./auth-config";

export async function createAuthClient() {
  const config = authConfig();
  if (!config) throw new Error("Supabase Auth is not configured.");
  const cookieStore = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookieOptions: sessionCookieOptions(process.env.NEXT_PUBLIC_APP_URL),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; the proxy refreshes them on requests.
        }
      },
    },
  });
}
