import { defineConfig, devices } from "@playwright/test";

// Keep test Auth traffic away from the normal developer app on port 3100.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3101);
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined } }],
  webServer: process.platform === "win32" ? undefined : {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    env: { SCOPEROOM_E2E: "1", NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}` },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
