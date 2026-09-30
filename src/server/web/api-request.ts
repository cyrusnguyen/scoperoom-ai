import "server-only";
import { projectErrors } from "@/features/projects/contracts/errors";
import { readProcessEnv } from "@/server/env";
import { authConfig } from "./auth-config.ts";
import { apiError, apiFailure, apiResponse, requestIdFor } from "./api-response.ts";
import { identityFrom, type IdentityResult, type VerifiedIdentity } from "./identity.ts";
import { createAuthClient } from "./supabase.ts";

async function currentIdentity(): Promise<IdentityResult> {
  if (!authConfig()) return { kind: "unavailable" };
  return identityFrom(async () => (await createAuthClient()).auth.getUser());
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

export type { VerifiedIdentity };

/** A definitive denial is 401; an Auth outage or missing configuration is a retryable 503 and never authorizes. */
function denied(identity: Exclude<IdentityResult, { kind: "user" }>, requestId: string) {
  return identity.kind === "none"
    ? apiError("UNAUTHENTICATED", "Sign in to continue.", 401, requestId)
    : apiError("UNAVAILABLE", projectErrors.UNAVAILABLE.message, 503, requestId);
}

/** Authenticated GET: verified identity, shared envelope, no-store. */
export async function readRoute(request: Request, run: (user: VerifiedIdentity) => Promise<unknown>) {
  const requestId = requestIdFor(request);
  const identity = await currentIdentity();
  if (identity.kind !== "user") return denied(identity, requestId);
  try { return apiResponse(await run(identity.user), 200, requestId); } catch (error) { return apiFailure(error, requestId); }
}

/**
 * Authenticated POST/PATCH/DELETE: exact same-origin, bounded JSON object body (4 KiB unless `bodyLimit` says otherwise), and the
 * Idempotency-Key header passed to the validator as `key`. `keyless` is for a nonmutating preview: no key is required or passed.
 */
export async function mutationRoute(
  request: Request,
  run: (user: VerifiedIdentity, input: Record<string, unknown>) => Promise<object & { replayed?: boolean }>,
  options: { createdStatus?: number; bodyLimit?: number; keyless?: boolean } = {},
) {
  const requestId = requestIdFor(request);
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return apiError("INVALID_REQUEST", "This request could not be accepted.", 403, requestId);
  const identity = await currentIdentity();
  if (identity.kind !== "user") return denied(identity, requestId);
  const body = await boundedJsonBody(request, options.bodyLimit);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "key") || (!key && !options.keyless)) return apiError("INVALID_INPUT", projectErrors.INVALID_INPUT.message, 400, requestId);
  try {
    const result = await run(identity.user, options.keyless ? { ...(body as Record<string, unknown>) } : { ...(body as Record<string, unknown>), key });
    return apiResponse(result, options.createdStatus && !result.replayed ? options.createdStatus : 200, requestId);
  } catch (error) { return apiFailure(error, requestId); }
}
