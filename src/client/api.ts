// Browser side of the shared API envelope (src/contracts/http.ts): one place that turns a fetch into a typed result.
import type { ErrorBody, ErrorDetails } from "../contracts/http.ts";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; status: number; details?: ErrorDetails; uncertain: boolean };

export const SESSION_ENDED = "scoperoom:session-ended";
const unavailable = "ScopeRoom is unavailable right now. Try again.";

async function settle<T>(request: () => Promise<Response>): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await request();
  } catch {
    // Network failure or an aborted request: the server may or may not have acted.
    return { ok: false, code: "NETWORK", message: "We could not reach ScopeRoom. Check your connection and retry.", status: 0, uncertain: true };
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* A non-JSON body is treated as unavailable below. */ }
  if (response.ok && body !== null) return { ok: true, data: body as T };
  const error = (body as Partial<ErrorBody> | null)?.error;
  // A 2xx without a readable body is also uncertain: a mutation may have committed.
  const result: ApiResult<T> = { ok: false, code: error?.code ?? "UNAVAILABLE", message: error?.message ?? unavailable, status: response.status, uncertain: response.status >= 500 || response.ok };
  return error?.details ? { ...result, details: error.details } : result;
}

export function apiRead<T>(url: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  return settle<T>(() => fetch(url, { cache: "no-store", signal }));
}

/**
 * Callers keep `key` and reuse it to retry an uncertain result; a certain failure should get a new key.
 * `null` is for a nonmutating preview POST, which takes no Idempotency-Key.
 */
export function apiMutate<T>(url: string, key: string | null, body: Record<string, unknown> = {}, method: "POST" | "PATCH" | "DELETE" = "POST"): Promise<ApiResult<T>> {
  return settle<T>(() => fetch(url, { method, headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }));
}

/**
 * A 401 means the session ended: a full load of sign-in drops every private value held in memory.
 * Router navigation would keep that state, and `replace` also keeps the ended page out of Back history.
 */
export function sessionEnded(result: ApiResult<unknown>, to = "/login"): boolean {
  if (result.ok || result.status !== 401) return false;
  // The shell listens, so it can stop polling and clear what it shows before the page is replaced.
  window.dispatchEvent(new Event(SESSION_ENDED));
  window.location.replace(to);
  return true;
}
