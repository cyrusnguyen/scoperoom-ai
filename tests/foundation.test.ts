import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function moduleLoads(path: string) {
  try {
    await import(path);
    return true;
  } catch {
    return false;
  }
}

test("foundation modules are available to plain Node", async () => {
  assert.equal(await moduleLoads("../src/server/env.ts"), true);
  assert.equal(await moduleLoads("../src/server/logger.ts"), true);
});

test("generated Prisma client loads in plain Node", async () => {
  const generated = await import("../prisma/generated/client.ts");
  assert.equal(typeof generated.PrismaClient, "function");
});

test("logger omits secret canaries and raw exceptions", async () => {
  const { createLogger } = await import("../src/server/logger.ts");
  const lines: string[] = [];
  const logger = createLogger({
    environment: "test",
    releaseId: "local",
    write: (line: string) => lines.push(line),
  });

  logger.error({
    component: "test",
    eventName: "request.failed",
    outcome: "failure",
    requestId: "request-1",
    error: new Error("canary-error-secret"),
    authorization: "canary-header-secret",
    input: "canary-prompt-secret",
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /"safeFailureCode":"INTERNAL_ERROR"/);
  assert.doesNotMatch(lines[0], /canary-(?:error|header|prompt)-secret/);
});

test("logger rejects unrecognised labels before writing", async () => {
  const { createLogger } = await import("../src/server/logger.ts");
  const lines: string[] = [];
  const logger = createLogger({ write: (line: string) => lines.push(line) });

  logger.info({ component: "canary-component-secret", eventName: "canary-event-secret", outcome: "success" });

  assert.doesNotMatch(lines[0], /canary-(?:component|event)-secret/);
});

test("process configuration validates the consumed environment", async () => {
  const { readProcessEnv } = await import("../src/server/env.ts");

  assert.deepEqual(readProcessEnv({ APP_ENV: "test", NEXT_PUBLIC_APP_URL: "https://scope.example/" }), {
    appEnv: "test",
    appUrl: "https://scope.example",
  });
  assert.throws(() => readProcessEnv({ APP_ENV: "production" }), /NEXT_PUBLIC_APP_URL/);
  assert.throws(() => readProcessEnv({ NODE_ENV: "production" }), /NEXT_PUBLIC_APP_URL/);
  assert.throws(() => readProcessEnv({ APP_ENV: "test", NEXT_PUBLIC_APP_URL: "ftp://scope.example" }), /http/);
  assert.throws(() => readProcessEnv({ APP_ENV: "test", NEXT_PUBLIC_APP_URL: "https://scope.example/private" }), /origin/);
});

test("boundary checker rejects client-to-server imports and permits server rendering a client leaf", async () => {
  const { checkBoundaries } = await import("../scripts/check-boundaries.mjs");
  const root = await mkdtemp(join(tmpdir(), "scoperoom-boundaries-"));
  try {
    await mkdir(join(root, "src", "app"), { recursive: true });
    await mkdir(join(root, "src", "client"), { recursive: true });
    await mkdir(join(root, "src", "server"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }));
    await writeFile(join(root, "src", "server", "env.ts"), "export const secret = 'server-only';");
    await writeFile(join(root, "src", "client", "leaf.tsx"), "'use client'; export const Leaf = () => null;");
    await writeFile(join(root, "src", "app", "page.tsx"), "import { Leaf } from '@/client/leaf'; export default Leaf;");

    assert.deepEqual(checkBoundaries(root), []);

    await writeFile(join(root, "src", "client", "leaf.tsx"), "'use client'; export { secret } from '@/server/env';");
    assert.match(checkBoundaries(root).join("\n"), /client import reaches trusted module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logger discards untrusted metadata and survives sink failure", async () => {
  const { createLogger } = await import("../src/server/logger.ts");
  const lines: string[] = [];
  const logger = createLogger({ environment: "canary-env-secret", releaseId: "canary-release-secret", write: line => lines.push(line) });
  logger.error({ component: "web", eventName: "request.failed", outcome: "failure", safeFailureCode: "canary-code-secret", requestId: "canary-id-secret", routeTemplate: "/canary-route-secret" });
  assert.doesNotMatch(lines[0], /canary-\w+-secret/);
  assert.doesNotThrow(() => createLogger({ write: () => { throw new Error("sink down"); } }).info({ component: "web", eventName: "request.completed", outcome: "success" }));
});

test("boundary checker covers relative, aliases, re-exports, dynamic imports and worker to Next", async () => {
  const { checkBoundaries } = await import("../scripts/check-boundaries.mjs");
  const root = await mkdtemp(join(tmpdir(), "scoperoom-boundaries-"));
  try {
    for (const path of ["src/app/api/health", "src/client", "src/server/web", "src/trigger", "src/features/access/server"]) await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }));
    await writeFile(join(root, "src/server/web/session.ts"), "export const secret = true;");
    await writeFile(join(root, "src/features/access/server/session.ts"), "export const secret = true;");
    await writeFile(join(root, "src/app/api/health/route.ts"), "export const secret = process.env.DATABASE_URL;");
    const leaf = join(root, "src/client/leaf.tsx");
    await writeFile(leaf, "'use client'; export { secret } from '../server/web/session';");
    assert.match(checkBoundaries(root).join("\n"), /client import reaches trusted module/);
    await writeFile(leaf, "'use client'; export const x = import('@/server/web/session');");
    assert.match(checkBoundaries(root).join("\n"), /client import reaches trusted module/);
    await writeFile(leaf, "'use client'; export { secret } from '@/features/access/server/session';");
    assert.match(checkBoundaries(root).join("\n"), /client import reaches trusted module/);
    await writeFile(leaf, "'use client'; export { secret } from '@/app/api/health/route';");
    assert.match(checkBoundaries(root).join("\n"), /client import reaches trusted module/);
    await writeFile(leaf, "'use client'; const target = '@/server/web/session'; export const x = import(target);");
    assert.match(checkBoundaries(root).join("\n"), /computed dynamic import/);
    await writeFile(leaf, "'use client'; export const x = true;");
    await writeFile(join(root, "src/trigger/job.ts"), "export { secret } from '@/server/web/session';");
    assert.match(checkBoundaries(root).join("\n"), /worker import reaches Next/);
    await writeFile(join(root, "src/trigger/job.ts"), "import { cookies } from 'next/headers'; export const job = cookies;");
    assert.match(checkBoundaries(root).join("\n"), /worker import reaches Next/);
    const script = fileURLToPath(new URL("../scripts/check-boundaries.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, `CLI skipped boundary findings: ${result.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Node startup validation rejects missing production origin before serving", () => {
  const run = (appEnv: string, appUrl?: string) => spawnSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module",
    "-e", "import('./src/instrumentation.ts').then(m => m.register())",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NEXT_RUNTIME: "nodejs", APP_ENV: appEnv, NEXT_PUBLIC_APP_URL: appUrl ?? "" },
  });
  const invalid = run("production");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /NEXT_PUBLIC_APP_URL is required/);
  const local = run("development");
  assert.equal(local.status, 0, local.stderr);
});