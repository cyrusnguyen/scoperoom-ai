import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { historyProblem } from "./history.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/db/guard.mjs"]);
run(process.execPath, ["scripts/db/guard.mjs", "--migration"]);
run(process.execPath, ["scripts/db/guard.mjs", "--provision-migration-auth-reference"]);

const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL });
await database.connect();
let problem;
try {
  const { rows: [row] } = await database.query(`select to_regclass('app._prisma_migrations') is not null as app, to_regclass('public._prisma_migrations') is not null as public`);
  const schema = row.public ? "public" : row.app ? "app" : null;
  const applied = schema === "app" ? (await database.query("select migration_name from app._prisma_migrations")).rows.map((entry) => entry.migration_name) : [];
  const local = readdirSync(new URL("../../prisma/migrations/", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  problem = historyProblem(schema, applied, local);
} finally {
  await database.end();
}
if (problem) {
  console.error(problem);
  process.exit(1);
}
const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL);
migrationUrl.searchParams.set("schema", "app");
process.env.MIGRATION_DATABASE_URL = migrationUrl.toString();

run(process.platform === "win32" ? "corepack.cmd" : "corepack", ["pnpm", "exec", "prisma", "migrate", "deploy"]);
run(process.execPath, ["scripts/db/guard.mjs"]);
