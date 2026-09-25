import assert from "node:assert/strict";
import test from "node:test";

import { continuationQuery, safeInviteContinuation } from "../src/features/access/server/continuation.ts";

const token = "a".repeat(43);

test("only an exact 32-byte base64url invitation path is retained through authentication", () => {
  assert.equal(safeInviteContinuation(`/invite/${token}`), `/invite/${token}`);
  assert.equal(continuationQuery(`/invite/${token}`), `?continue=%2Finvite%2F${token}`);
});

test("continuation rejects external, nested, short, and query-bearing values", () => {
  for (const value of ["https://example.test", "//example.test", "/app", "/invite/short", `/invite/${token}?next=/app`, `/invite/${token}/extra`]) {
    assert.equal(safeInviteContinuation(value), null);
  }
});