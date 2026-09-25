import "server-only";
import { authConfig } from "./auth-config.ts";
import { createAuthClient } from "./supabase.ts";

export async function verifiedIdentity() {
  if (!authConfig()) return null;
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !user.email_confirmed_at || user.is_anonymous || typeof user.email !== "string") return null;
  const rawName = user.user_metadata.full_name;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  return { authUserId: user.id, displayName: name && name.length <= 80 ? name : "there", verifiedEmail: user.email.normalize("NFC").trim().toLowerCase() };
}

export async function boundedJsonBody(request: Request, limit = 4_096): Promise<unknown | null> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
