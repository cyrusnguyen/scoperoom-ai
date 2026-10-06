import { defineConfig, devices } from "@playwright/test";
import { withoutProviderSecrets } from "./scripts/e2e/provider-env.mjs";

// Playwright 1.63 adds page snapshots to error context unless this pinned runner opt-out is set.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

// Keep test Auth traffic away from the normal developer app on port 3100.
const port = Number(process.env.PLAYWRIGHT_PORT?.trim() || 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");
const appUrl = `http://127.0.0.1:${port}`;
const production = process.env.SCOPEROOM_E2E_SERVER === "production";
const faultPort = Number(process.env.RECOVERY_FAULT_PORT?.trim() || port + 100);
if (production && (!Number.isInteger(faultPort) || faultPort < 1 || faultPort > 65535 || faultPort === port)) throw new Error("RECOVERY_FAULT_PORT must be a separate valid TCP port.");
const faultAppUrl = `http://127.0.0.1:${faultPort}`;
const workers = Number(process.env.PLAYWRIGHT_WORKERS?.trim() || (production ? 2 : 1));
if (!Number.isInteger(workers) || workers < 1 || workers > 2) throw new Error("PLAYWRIGHT_WORKERS must be 1 or 2.");
process.env.NEXT_PUBLIC_APP_URL = appUrl;
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // next dev compiles each page/API route on its first request (5-8s observed on Windows),
  // so the first assertion that depends on a newly hit route needs more than the 5s default.
  expect: { timeout: 10_000 },
  workers,
  reporter: [["list"], ["json", { outputFile: "test-results/playwright-results.json" }]],
  use: { baseURL: appUrl, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /password-recovery-fault\.spec\.ts/, use: { ...devices["Desktop Chrome"], launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } },
    ...(production ? [{ name: "recovery-fault", testMatch: /password-recovery-fault\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: faultAppUrl, launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } }] : []),
  ],
  webServer: production ? [
    {
      command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: appUrl,
    env: withoutProviderSecrets({ SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: appUrl }), // blank provider keys: the e2e server stays network-free
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    },
    {
      command: `node --import ./tests/support/recovery-auth-fault.mjs node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${faultPort}`,
      url: faultAppUrl,
      env: withoutProviderSecrets({
        SCOPEROOM_E2E: "1",
        NEXT_PUBLIC_APP_URL: faultAppUrl,
        RECOVERY_FAULT_AUTH_ORIGIN: process.env.RECOVERY_FAULT_AUTH_ORIGIN,
        RECOVERY_FAULT_FILE: process.env.RECOVERY_FAULT_FILE,
        RECOVERY_FAULT_RESULT_FILE: process.env.RECOVERY_FAULT_RESULT_FILE,
      }),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ] : process.platform !== "win32" ? {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    url: appUrl,
    env: withoutProviderSecrets({ SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: appUrl }),
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  } : undefined,
});
