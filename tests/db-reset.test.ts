import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { resetLocal } from "../scripts/db/reset.mjs";

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv; shell: boolean; cwd?: string };

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scoperoom-reset-")));
  // The CLI receives this as one literal argument, including on Windows.
  const root = join(dir, "alternate workdir & literal");
  mkdirSync(join(root, "supabase"), { recursive: true });
  const config = join(root, "supabase", "config.toml");
  writeFileSync(config, 'project_id = "alternate-local"\n[db]\nport = 62322\n');
  const env = { ...process.env, SCOPEROOM_SUPABASE_CONFIG: config, SCOPEROOM_ENVIRONMENT_ID: "new-id", SCOPEROOM_CURRENT_ENVIRONMENT_ID: "old-id", SUPABASE_PROJECT_ID: "hostile", SUPABASE_DB_PORT: "54322", SUPABASE_WORKDIR: "hostile-directory", SUPABASE_CLI_BINARY_OVERRIDE: "hostile-executable" };
  const calls: Call[] = [];
  const state = { failAt: -1, status: 17 as number | null, projectId: "alternate-local", hostIp: "127.0.0.1", port: "62322", networks: ["alternate-loopback"], loopback: true, dockerFailure: false };
  t.mock.method(childProcess, "spawnSync", (command: string, args: string[], options: { env: NodeJS.ProcessEnv; shell: boolean; cwd?: string }) => {
    calls.push({ command, args, ...options });
    return { status: calls.length - 1 === state.failAt ? state.status : 0 };
  });
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (state.dockerFailure) throw new Error("inspection unavailable");
    return JSON.stringify(args[0] === "inspect" ? [{ Config: { Labels: { "com.supabase.cli.project": state.projectId } }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: state.hostIp, HostPort: state.port }] }, Networks: Object.fromEntries(state.networks.map((name) => [name, {}])) } }] : [{ Options: { "com.docker.network.bridge.host_binding_ipv4": state.loopback ? "127.0.0.1" : "0.0.0.0" } }]);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, dir, root, env, calls, state };
}

test("reset binds the verified alternate config, project, port and loopback network despite inherited CLI overrides", (t) => {
  const { config, root, env, calls } = fixture(t);
  resetLocal(env);
  assert.equal(calls.length, 3);
  assert.match(calls[1].args[0], /supabase[\\/]dist[\\/]supabase\.js$/);
  assert.deepEqual(calls[1].args.slice(1), ["db", "reset", "--local", "--workdir", root, "--network-id", "alternate-loopback"]);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.shell, false);
    assert.equal(call.env.SCOPEROOM_SUPABASE_CONFIG, config);
    assert.equal(call.env.SUPABASE_PROJECT_ID, "alternate-local");
    assert.equal(call.env.SUPABASE_DB_PORT, "62322");
    assert.equal(call.env.SUPABASE_WORKDIR, root);
    assert.equal(call.env.SUPABASE_CLI_BINARY_OVERRIDE, undefined);
  }
  assert.equal(calls[0].env.SCOPEROOM_ENVIRONMENT_ID, "old-id");
  assert.equal(calls[1].env.SCOPEROOM_ENVIRONMENT_ID, "new-id");
  assert.equal(calls[2].env.SCOPEROOM_ENVIRONMENT_ID, "new-id");
  assert.match(calls[0].args[0], /guard\.mjs$/);
  assert.match(calls[2].args[0], /bootstrap\.mjs$/);
});

test("reset pins child working directories to its source checkout when invoked elsewhere", (t) => {
  const { dir, env, calls } = fixture(t);
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    resetLocal(env);
    assert.equal(calls.length, 3);
    const sourceRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
    for (const call of calls) {
      assert.equal(resolve(call.cwd ?? process.cwd()), sourceRoot);
    }
  } finally {
    process.chdir(originalCwd);
  }
});
for (const [name, content] of [
  ["missing database section", 'project_id = "alternate-local"\n[api]\nport = 62322\n'],
  ["empty database section", 'project_id = "alternate-local"\n[db]\n[api]\nport = 62322\n'],
  ["invalid project id", 'project_id = "bad project"\n[db]\nport = 62322\n'],
  ["out-of-range port", 'project_id = "alternate-local"\n[db]\nport = 99999\n'],
] as const) {
  test(`reset refuses ${name} before any command`, (t) => {
    const { config, env, calls } = fixture(t);
    writeFileSync(config, content);
    assert.throws(() => resetLocal(env), /configuration/);
    assert.equal(calls.length, 0);
  });
}

test("reset refuses arbitrary config layout and linked config ancestry before any command", (t) => {
  const { config, dir, root, env, calls } = fixture(t);
  const arbitrary = join(dir, "custom.toml");
  writeFileSync(arbitrary, 'project_id = "alternate-local"\n[db]\nport = 62322\n');
  assert.throws(() => resetLocal({ ...env, SCOPEROOM_SUPABASE_CONFIG: arbitrary }), /unlinked/);
  const linked = join(dir, "linked");
  symlinkSync(root, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resetLocal({ ...env, SCOPEROOM_SUPABASE_CONFIG: join(linked, "supabase", "config.toml") }), /unlinked/);
  assert.throws(() => resetLocal({ ...env, SCOPEROOM_SUPABASE_CONFIG: `${config}.missing` }), /ENOENT/);
  assert.equal(calls.length, 0);
});

for (const failure of ["foreign project", "public port", "wrong port", "public network", "ambiguous network", "inspection unavailable"] as const) {
  test(`reset refuses ${failure} after guard without invoking CLI or bootstrap`, (t) => {
    const { env, calls, state } = fixture(t);
    if (failure === "foreign project") state.projectId = "other-project";
    if (failure === "public port") state.hostIp = "0.0.0.0";
    if (failure === "wrong port") state.port = "54322";
    if (failure === "public network") state.loopback = false;
    if (failure === "ambiguous network") state.networks.push("second-loopback");
    if (failure === "inspection unavailable") state.dockerFailure = true;
    assert.throws(() => resetLocal(env), /guard|ambiguous/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].args[0], /guard\.mjs$/);
  });
}

for (const failAt of [0, 1, 2]) {
  test(`reset stops on command ${failAt + 1} failure and preserves its exit status`, (t) => {
    const { env, calls, state } = fixture(t);
    state.failAt = failAt;
    assert.throws(() => resetLocal(env), (error: unknown) => error instanceof Error && "exitCode" in error && error.exitCode === 17);
    assert.equal(calls.length, failAt + 1);
  });
}

test("reset turns a spawn failure into a nonzero status and never continues", (t) => {
  const { env, calls, state } = fixture(t);
  state.failAt = 0;
  state.status = null;
  assert.throws(() => resetLocal(env), (error: unknown) => error instanceof Error && "exitCode" in error && error.exitCode === 1);
  assert.equal(calls.length, 1);
});

test("importing reset launches no command", () => {
  const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../scripts/db/reset.mjs", import.meta.url).href)})`], { encoding: "utf8", env: { ...process.env, SCOPEROOM_SUPABASE_CONFIG: "missing-config" } });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
});
