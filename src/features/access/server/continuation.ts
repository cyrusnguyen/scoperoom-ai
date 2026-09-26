const inviteToken = /^[A-Za-z0-9_-]{43}$/;

// Only invitation routes may survive the authentication boundary. This keeps
// continuation handling from turning the sign-in screens into open redirects.
export function safeInviteContinuation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\/invite\/([^/?#]+)$/.exec(value);
  return match && inviteToken.test(match[1]) ? value : null;
}

// Adds a safe continuation to a path whether or not it already carries a query.
export function withContinuation(path: string, value: unknown): string {
  const continuation = safeInviteContinuation(value);
  return continuation ? `${path}${path.includes("?") ? "&" : "?"}continue=${encodeURIComponent(continuation)}` : path;
}