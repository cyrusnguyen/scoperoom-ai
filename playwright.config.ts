import { defineConfig, devices } from "@playwright/test";

// Keep test Auth traffic away from the normal developer app on port 3100.
const port = Number(process.env.PLAYWRIGHT_PORT?.trim() || 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");
const appUrl = `http://127.0.0.1:${port}`;
const production = process.env.SCOPEROOM_E2E_SERVER === "production";
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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } }],
  webServer: production || process.platform !== "win32" ? {
    command: `node node_modules/next/dist/bin/next ${production ? "start" : "dev"} --hostname 127.0.0.1 --port ${port}`,
    url: appUrl,
    env: { SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: appUrl },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  } : undefined,
});
