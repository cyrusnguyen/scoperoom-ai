import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { classifyIdentity, identityFrom } from "../src/server/web/identity.ts";

const user = (over: Partial<User> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  email: "Ada@Example.COM ",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  is_anonymous: false,
  user_metadata: { full_name: "  Ada   Lovelace " },
  ...over,
}) as User;

test("a verified, confirmed, non-anonymous user becomes a normalized identity", () => {
  assert.deepEqual(classifyIdentity({ user: user(), error: null }), { kind: "user", user: { authUserId: "11111111-1111-4111-8111-111111111111", displayName: "Ada Lovelace", verifiedEmail: "ada@example.com" } });
  assert.deepEqual(classifyIdentity({ user: user({ user_metadata: {} }), error: null }), { kind: "user", user: { authUserId: "11111111-1111-4111-8111-111111111111", displayName: "Ada", verifiedEmail: "ada@example.com" } });
});

test("a missing, unconfirmed, anonymous or emailless user is a denial, never an outage", () => {
  for (const candidate of [null, user({ email_confirmed_at: undefined }), user({ is_anonymous: true }), user({ email: undefined })]) {
    assert.deepEqual(classifyIdentity({ user: candidate, error: null }), { kind: "none" });
  }
});

test("definitive Auth denials are 'none' and never authorize", () => {
  for (const error of [new AuthSessionMissingError(), new AuthApiError("bad", 400, "bad_jwt"), new AuthApiError("no", 401, "invalid_credentials"), new AuthApiError("gone", 403, "user_banned"), new AuthApiError("nf", 404, "user_not_found"), new AuthApiError("bad", 422, undefined)]) {
    assert.deepEqual(classifyIdentity({ user: user(), error }), { kind: "none" }, error.message);
  }
});

test("transport failures, timeouts, 5xx, throttling and unknown provider errors are 'unavailable'", () => {
  for (const error of [new AuthRetryableFetchError("fetch failed", 0), new AuthRetryableFetchError("bad gateway", 502), new AuthApiError("slow", 408, undefined), new AuthApiError("throttled", 429, "over_request_rate_limit"), new AuthApiError("boom", 500, undefined), new AuthUnknownError("<html>", new Error("x")), new AuthInvalidJwtError("clock"), new Error("plain"), "string"]) {
    assert.deepEqual(classifyIdentity({ user: user(), error }), { kind: "unavailable" }, String(error));
  }
});

test("thrown provider errors are classified the same way as returned ones", async () => {
  const throws = (error: unknown) => identityFrom(async () => { throw error; });
  assert.deepEqual(await throws(new AuthRetryableFetchError("fetch failed", 0)), { kind: "unavailable" });
  assert.deepEqual(await throws(new TypeError("fetch failed")), { kind: "unavailable" });
  assert.deepEqual(await throws(new AuthSessionMissingError()), { kind: "none" });
  assert.deepEqual(await throws(new AuthApiError("no", 401, undefined)), { kind: "none" });
  assert.deepEqual(await identityFrom(async () => ({ data: { user: user() }, error: null })), { kind: "user", user: { authUserId: "11111111-1111-4111-8111-111111111111", displayName: "Ada Lovelace", verifiedEmail: "ada@example.com" } });
  assert.deepEqual(await identityFrom(async () => ({ data: { user: null }, error: new AuthSessionMissingError() })), { kind: "none" });
  assert.deepEqual(await identityFrom(async () => ({ data: { user: null }, error: new AuthRetryableFetchError("down", 503) })), { kind: "unavailable" });
});
