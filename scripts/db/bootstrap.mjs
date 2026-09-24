import { spawnSync } from "node:child_process";

const node = process.execPath;
const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(node, ["scripts/db/guard.mjs", "--initial"]);
run(node, ["scripts/db/guard.mjs", "--provision-runtime"]);
run(node, ["scripts/db/guard.mjs", "--migration"]);
run(node, ["scripts/db/guard.mjs", "--provision-migration-auth-reference"]);
// A fresh private app installation keeps Prisma migration history in app.
const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL);
migrationUrl.searchParams.set("schema", "app");
process.env.MIGRATION_DATABASE_URL = migrationUrl.toString();
run(corepack, ["pnpm", "exec", "prisma", "migrate", "deploy"]);
run(node, ["scripts/db/guard.mjs", "--bind"]);
run(node, ["scripts/db/guard.mjs"]);
