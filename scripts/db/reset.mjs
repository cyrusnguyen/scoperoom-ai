import { spawnSync } from "node:child_process";

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const currentEnvironmentId = process.env.SCOPEROOM_CURRENT_ENVIRONMENT_ID ?? process.env.SCOPEROOM_ENVIRONMENT_ID;
run(process.execPath, ["scripts/db/guard.mjs"], { ...process.env, SCOPEROOM_ENVIRONMENT_ID: currentEnvironmentId });
// Keep the recreated database on the loopback-only network from scripts/ci/start-local-supabase.sh; without it the
// container returns on the default network, bound to all interfaces and unreachable by the other services.
run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "exec", "supabase", "db", "reset", "--local", "--network-id", "scoperoom-ci-loopback"]);
run(process.execPath, ["scripts/db/bootstrap.mjs"]);
