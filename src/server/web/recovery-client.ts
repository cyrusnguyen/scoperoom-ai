import "server-only";
import { createClient } from "@supabase/supabase-js";
import { authConfig } from "./auth-config";

export function createRecoveryClient() {
  const config = authConfig();
  if (!config) throw new Error("Supabase Auth is not configured.");
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
