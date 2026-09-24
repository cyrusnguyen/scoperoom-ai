import { spawnSync } from "node:child_process";
import { Client } from "pg";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/db/guard.mjs"]);
run(process.execPath, ["scripts/db/guard.mjs", "--migration"]);
run(process.execPath, ["scripts/db/guard.mjs", "--provision-migration-auth-reference"]);

// Stage 01 installations used public history; fresh installations use app.
const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL });
await database.connect();
let history;
try {
  const { rows: [row] } = await database.query(`select to_regclass('app._prisma_migrations') is not null as app, to_regclass('public._prisma_migrations') is not null as public`);
  if (row.app === row.public) throw new Error("Expected exactly one Prisma migration history.");
  history = row.app ? "app" : "public";
} finally {
  await database.end();
}
const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL);
migrationUrl.searchParams.set("schema", history);
process.env.MIGRATION_DATABASE_URL = migrationUrl.toString();

run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "exec", "prisma", "migrate", "deploy"]);
run(process.execPath, ["scripts/db/guard.mjs"]);
