import { authConfig } from "@/server/web/auth-config";
import { createAuthClient } from "@/server/web/supabase";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

function displayName(value: unknown) {
  if (typeof value !== "string") return "there";
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= 80 ? name : "there";
}

export async function GET() {
  if (!authConfig()) {
    return response({ error: { code: "UNAVAILABLE", message: "Workspace access is unavailable." } }, 503);
  }

  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !user.email_confirmed_at || user.is_anonymous) {
    return response({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
  }

  return response({ displayName: displayName(user.user_metadata.full_name) });
}
