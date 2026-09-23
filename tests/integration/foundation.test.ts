import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Prisma } from "../../prisma/generated/client.ts";
import { Client } from "pg";
import { createDatabase } from "../../src/server/db.ts";

const bootstrapUrl = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const webUrl = process.env.DATABASE_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const expected = process.env.SCOPEROOM_ENVIRONMENT_ID;

function postgresCode(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { code?: string } } };
  };
  return candidate.meta?.driverAdapterError?.cause?.code ?? candidate.meta?.code ?? candidate.code;
}

function rejectsPostgres(code: string) {
  return (error: unknown) => {
    assert.equal(postgresCode(error), code);
    return true;
  };
}

test("guard rejects an unresolvable non-loopback bootstrap target before migration", () => {
  assert.ok(expected, "SCOPEROOM_ENVIRONMENT_ID is required");
  const result = spawnSync(process.execPath, ["scripts/db/guard.mjs", "--initial"], {
    cwd: process.cwd(),
    env: { ...process.env, SCOPEROOM_BOOTSTRAP_DATABASE_URL: "postgresql://ignored@127.0.0.2:54322/postgres" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /non-local Supabase database target/);
});

test("guard rejects a partial or already-bound local app schema during bootstrap", () => {
  assert.ok(bootstrapUrl, "SCOPEROOM_BOOTSTRAP_DATABASE_URL is required");
  assert.ok(expected, "SCOPEROOM_ENVIRONMENT_ID is required");
  const result = spawnSync(process.execPath, ["scripts/db/guard.mjs", "--initial"], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /nonempty initial target/);
});

test("scoped migration login is separate from effective runtime roles", async () => {
  assert.ok(migrationUrl, "MIGRATION_DATABASE_URL is required");
  const migration = new Client({ connectionString: migrationUrl });
  await migration.connect();
  try {
    const { rows: [role] } = await migration.query("select current_user, session_user, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user");
    assert.equal(role.current_user, "app_migrator");
    assert.equal(role.session_user, "app_migrator_runtime");
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
  } finally {
    await migration.end();
  }
});

test("restricted Prisma pooler clients validate identity and enforce transaction boundaries", async () => {
  assert.ok(bootstrapUrl, "SCOPEROOM_BOOTSTRAP_DATABASE_URL is required");
  assert.ok(webUrl, "DATABASE_URL is required");
  assert.ok(workerUrl, "WORKER_DATABASE_URL is required");
  assert.ok(expected, "SCOPEROOM_ENVIRONMENT_ID is required");
  const cleanup = new Client({ connectionString: bootstrapUrl });
  const namespace = `test-${randomUUID()}`;
  const web = await createDatabase(webUrl, expected);
  const contender = await createDatabase(webUrl, expected);
  const worker = await createDatabase(workerUrl, expected);
  await cleanup.connect();
  try {
    const role = await web.$queryRaw<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select current_user::text, session_user::text, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`;
    assert.deepEqual(role, [{ current_user: "app_web", session_user: "app_web_runtime", rolsuper: false, rolbypassrls: false }]);
    await assert.rejects(createDatabase(webUrl, randomUUID()), /environment identity/);
    await assert.rejects(web.$executeRawUnsafe("create table app.forbidden_fixture(id int)"), rejectsPostgres("42501"));
    await assert.rejects(web.$executeRaw(Prisma.sql`update app.environment_identity set environment_id = ${randomUUID()}::uuid where id = 1`), rejectsPostgres("42501"));
    await assert.rejects(worker.$executeRaw(Prisma.sql`insert into app.transaction_fixture(namespace, code) values (${namespace}, 'worker-write')`), rejectsPostgres("42501"));
    await assert.rejects(async () => web.$transaction(async (tx) => {
      await tx.transactionFixture.create({ data: { namespace, code: "rollback" } });
      throw new Error("rollback fixture");
    }));
    assert.equal(await web.transactionFixture.count({ where: { namespace, code: "rollback" } }), 0);
    const locked = await web.transactionFixture.create({ data: { namespace, code: "locked" } });
    await web.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`select id from app.transaction_fixture where id = ${locked.id}::uuid for update`);
      await assert.rejects(contender.$transaction(async (other) => {
        await other.$executeRawUnsafe("set local lock_timeout = '250ms'");
        await other.$queryRaw(Prisma.sql`select id from app.transaction_fixture where id = ${locked.id}::uuid for update`);
      }), rejectsPostgres("55P03"));
    });
    await web.transactionFixture.create({ data: { namespace, code: "unique" } });
    await assert.rejects(web.transactionFixture.create({ data: { namespace, code: "unique" } }), (error: unknown) => {
      assert.equal(postgresCode(error), "P2002");
      return true;
    });
  } finally {
    await cleanup.query("delete from app.transaction_fixture where namespace = $1", [namespace]);
    await cleanup.end();
    await worker.$disconnect();
    await contender.$disconnect();
    await web.$disconnect();
  }
});
