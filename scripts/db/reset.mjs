import { spawnSync } from "node:child_process";

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const currentEnvironmentId = process.env.SCOPEROOM_CURRENT_ENVIRONMENT_ID ?? process.env.SCOPEROOM_ENVIRONMENT_ID;
run(process.execPath, ["scripts/db/guard.mjs"], { ...process.env, SCOPEROOM_ENVIRONMENT_ID: currentEnvironmentId });
run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "exec", "supabase", "db", "reset", "--local"]);
run(process.execPath, ["scripts/db/bootstrap.mjs"]);
