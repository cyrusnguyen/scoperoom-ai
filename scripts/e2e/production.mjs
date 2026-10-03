import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT?.trim() || 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");

const required = [
  "DATABASE_URL",
  "SCOPEROOM_ENVIRONMENT_ID",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_SECRET_KEY",
  "E2E_DATABASE_URL",
  "E2E_MAILPIT_URL",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) throw new Error(`Production browser tests require: ${missing.join(", ")}`);

const require = createRequire(import.meta.url);
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  SCOPEROOM_E2E: "1",
  SCOPEROOM_E2E_SERVER: "production",
  NEXT_PUBLIC_APP_URL: origin,
  // Admission only needs a model name and an opaque binding (no provider call is made); real values are never required for the gate.
  AI_MODEL: process.env.AI_MODEL?.trim() || "e2e-model",
  AI_EXECUTION_BINDING: process.env.AI_EXECUTION_BINDING?.trim() || "e2e-binding",
};
if (process.platform === "win32") {
  // Playwright stops its managed webServer with taskkill, which lives in System32.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = [env[pathKey], join(process.env.SystemRoot ?? "C:\\Windows", "System32")].filter(Boolean).join(delimiter);
}
const reportDir = "test-results";
mkdirSync(reportDir, { recursive: true });
rmSync(`${reportDir}/e2e-timing.json`, { force: true });
rmSync(`${reportDir}/playwright-results.json`, { force: true });

function run(cli, args) {
  const result = spawnSync(process.execPath, [require.resolve(cli), ...args], { env, stdio: "inherit" });
  if (result.error) console.error(result.error);
  return result.status ?? 1;
}

const started = performance.now();
const buildExitCode = run("next/dist/bin/next", ["build"]);
const buildMs = Math.round(performance.now() - started);
let testExitCode = null;
let testMs = null;
if (buildExitCode === 0) {
  const testStarted = performance.now();
  testExitCode = run("@playwright/test/cli", ["test", "--project=chromium", ...process.argv.slice(2)]);
  testMs = Math.round(performance.now() - testStarted);
}

const timing = {
  origin,
  buildMs,
  testMs,
  totalMs: Math.round(performance.now() - started),
  buildExitCode,
  testExitCode,
};
writeFileSync(`${reportDir}/e2e-timing.json`, `${JSON.stringify(timing, null, 2)}\n`);
console.log(`Browser run timing: build ${buildMs} ms, test ${testMs ?? "not run"} ms, total ${timing.totalMs} ms.`);
process.exitCode = buildExitCode || testExitCode || 0;
