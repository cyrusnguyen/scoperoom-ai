import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieOptions } from "../src/features/access/session-cookies.ts";

test("session cookies are HttpOnly and Lax everywhere, Secure only over HTTPS", () => {
  assert.deepEqual(sessionCookieOptions("http://127.0.0.1:3101"), { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
  assert.equal(sessionCookieOptions("https://scoperoom.example").secure, true);
  assert.equal(sessionCookieOptions(undefined).secure, false);
});
