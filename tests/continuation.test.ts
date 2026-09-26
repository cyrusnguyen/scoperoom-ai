import assert from "node:assert/strict";
import test from "node:test";

import { safeInviteContinuation, withContinuation } from "../src/features/access/server/continuation.ts";

const token = "a".repeat(43);

test("only an exact 32-byte base64url invitation path is retained through authentication", () => {
  assert.equal(safeInviteContinuation(`/invite/${token}`), `/invite/${token}`);
  assert.equal(withContinuation("/login", `/invite/${token}`), `/login?continue=%2Finvite%2F${token}`);
});

test("continuation joins a path that already carries a query with &", () => {
  assert.equal(withContinuation("/login?error=invalid", `/invite/${token}`), `/login?error=invalid&continue=%2Finvite%2F${token}`);
  assert.equal(withContinuation("/signup?error=unavailable", `/invite/${token}`), `/signup?error=unavailable&continue=%2Finvite%2F${token}`);
  assert.equal(withContinuation("/login?error=invalid", "https://example.test"), "/login?error=invalid");
  assert.equal(withContinuation("/signup", null), "/signup");
});

test("continuation rejects external, nested, short, and query-bearing values", () => {
  for (const value of ["https://example.test", "//example.test", "/app", "/invite/short", `/invite/${token}?next=/app`, `/invite/${token}/extra`]) {
    assert.equal(safeInviteContinuation(value), null);
  }
});
