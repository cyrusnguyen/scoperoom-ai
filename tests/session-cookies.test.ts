import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieOptions } from "../src/features/access/session-cookies.ts";

test("session cookies are HttpOnly and Lax everywhere, Secure only over HTTPS", () => {
  assert.deepEqual(sessionCookieOptions({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3101" }), { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
  assert.equal(sessionCookieOptions({ NEXT_PUBLIC_APP_URL: "https://scoperoom.example" }).secure, true);
  assert.equal(sessionCookieOptions({}).secure, false);
});

test("Vercel fallback origins always issue Secure session cookies", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "scoperoom.example" });
    for (const url of [undefined, "http://localhost:3100", "http://127.0.0.1:3101"]) {
      if (url === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = url;
      assert.equal(sessionCookieOptions(undefined).secure, true);
    }
  } finally {
    process.env = saved;
  }
});
