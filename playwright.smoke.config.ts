import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

if (existsSync(".env.smoke.local")) process.loadEnvFile(".env.smoke.local");
// The smoke signs in with real accounts and writes to the target: accept only a bare HTTPS origin, never a loopback default.
const url = new URL(process.env.SMOKE_URL?.trim() || "about:blank");
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("SMOKE_URL must be the target's bare HTTPS origin.");

export default defineConfig({
  testDir: "./tests/smoke",
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000, // two AI runs may each take up to the 300 s SQL deadline
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/smoke-results.json" }]],
  use: { ...devices["Desktop Chrome"], baseURL: url.origin, trace: "retain-on-failure" },
});
