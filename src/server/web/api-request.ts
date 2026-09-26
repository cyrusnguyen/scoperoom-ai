import "server-only";
import { projectErrors } from "@/features/projects/contracts/errors";
import { readProcessEnv } from "@/server/env";
import { authConfig } from "./auth-config.ts";
import { apiError, apiFailure, apiResponse, requestIdFor } from "./api-response.ts";
import { createAuthClient } from "./supabase.ts";

export async function verifiedIdentity() {
  if (!authConfig()) return null;
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !user.email_confirmed_at || user.is_anonymous || typeof user.email !== "string") return null;
  const rawName = user.user_metadata.full_name;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  const fallback = user.email.split("@")[0]!.slice(0, 80);
  return { authUserId: user.id, displayName: name && name.length <= 80 ? name : fallback, verifiedEmail: user.email.normalize("NFC").trim().toLowerCase() };
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

export type VerifiedIdentity = NonNullable<Awaited<ReturnType<typeof verifiedIdentity>>>;

function unauthenticated(requestId: string) {
  return authConfig()
    ? apiError("UNAUTHENTICATED", "Sign in to continue.", 401, requestId)
    : apiError("UNAVAILABLE", projectErrors.UNAVAILABLE.message, 503, requestId);
}

/** Authenticated GET: verified identity, shared envelope, no-store. */
export async function readRoute(request: Request, run: (user: VerifiedIdentity) => Promise<unknown>) {
  const requestId = requestIdFor(request);
  const user = await verifiedIdentity();
  if (!user) return unauthenticated(requestId);
  try { return apiResponse(await run(user), 200, requestId); } catch (error) { return apiFailure(error, requestId); }
}

/** Authenticated mutation: exact same-origin, bounded JSON object body, Idempotency-Key header passed to the validator as `key`. */
export async function mutationRoute(
  request: Request,
  run: (user: VerifiedIdentity, input: Record<string, unknown>) => Promise<{ replayed?: boolean }>,
  options: { createdStatus?: number } = {},
) {
  const requestId = requestIdFor(request);
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return apiError("INVALID_REQUEST", "This request could not be accepted.", 403, requestId);
  const user = await verifiedIdentity();
  if (!user) return unauthenticated(requestId);
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || !key) return apiError("INVALID_INPUT", projectErrors.INVALID_INPUT.message, 400, requestId);
  try {
    const result = await run(user, { ...(body as Record<string, unknown>), key });
    return apiResponse(result, options.createdStatus && !result.replayed ? options.createdStatus : 200, requestId);
  } catch (error) { return apiFailure(error, requestId); }
}
