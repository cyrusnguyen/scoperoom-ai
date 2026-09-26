export type ErrorDetails = Record<string, string | number | boolean | null>;
export type ErrorBody = { error: { code: string; message: string; requestId: string; retryable: boolean; details?: ErrorDetails } };

export const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared error envelope; only server-side failures invite an automatic retry. */
export function errorBody(code: string, message: string, status: number, requestId: string, details?: ErrorDetails): ErrorBody {
  return { error: { code, message, requestId, retryable: status >= 500, ...(details ? { details } : {}) } };
}
