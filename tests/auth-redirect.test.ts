import assert from "node:assert/strict";
import test from "node:test";
import * as env from "../src/server/env.ts";
const { readProcessEnv } = env;

test("Vercel uses its production domain when a stale local app URL is configured", () => {
  const config = readProcessEnv({
    APP_ENV: "production",
    VERCEL: "1",
    VERCEL_PROJECT_PRODUCTION_URL: "scope.vercel.app",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  });
  assert.equal(config.appUrl, "https://scope.vercel.app");
});

test("Vercel refuses a localhost app URL when no production domain is available", () => {
  assert.throws(() => readProcessEnv({
    APP_ENV: "production",
    VERCEL: "1",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  }), /production URL/);
});

test("Vercel accepts an explicitly configured HTTPS app origin", () => {
  const config = readProcessEnv({
    APP_ENV: "production",
    VERCEL: "1",
    VERCEL_PROJECT_PRODUCTION_URL: "scope.vercel.app",
    NEXT_PUBLIC_APP_URL: "https://scope.example",
  });
  assert.equal(config.appUrl, "https://scope.example");
});
test("signup confirmation redirects to the deployed sign-in page", () => {
  assert.equal(typeof env.confirmationRedirectUrl, "function");
  assert.equal(env.confirmationRedirectUrl({
    APP_ENV: "production",
    VERCEL: "1",
    VERCEL_PROJECT_PRODUCTION_URL: "scope.vercel.app",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  }), "https://scope.vercel.app/login");
});