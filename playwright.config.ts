import { defineConfig, devices } from "@playwright/test";

// Keep test Auth traffic away from the normal developer app on port 3100.
const port = Number(process.env.PLAYWRIGHT_PORT?.trim() || 3101);
const appUrl = `http://127.0.0.1:${port}`;
process.env.NEXT_PUBLIC_APP_URL = appUrl;
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // next dev compiles each page/API route on its first request (5-8s observed on Windows),
  // so the first assertion that depends on a newly hit route needs more than the 5s default.
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "list",
  use: { baseURL: appUrl, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } }],
  webServer: process.platform === "win32" ? undefined : {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    url: appUrl,
    env: { SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: appUrl },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
