import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/db/guard.mjs"]);
run(process.execPath, ["scripts/db/guard.mjs", "--migration"]);
run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "exec", "prisma", "migrate", "deploy"]);
run(process.execPath, ["scripts/db/guard.mjs"]);
