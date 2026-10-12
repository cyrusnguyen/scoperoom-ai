import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BASELINE_MIGRATION, hostedTarget, migrationTargetMatches, providerGrantProblems, splitBaselineAuthReference, targetKind } from "../scripts/db/guard.mjs";

const ref = "abcdefghijklmnopqrst";

test("targetKind defaults to local and fails closed on anything but local or hosted", () => {
  assert.equal(targetKind({}), "local");
  assert.equal(targetKind({ SCOPEROOM_DB_TARGET: "hosted" }), "hosted");
  for (const value of ["Hosted", "remote", "prod"]) assert.throws(() => targetKind({ SCOPEROOM_DB_TARGET: value }), /local or hosted/);
});

test("hostedTarget accepts only the configured project over TLS on port 5432", () => {
  assert.deepEqual(hostedTarget(`postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres?sslmode=require`, ref), { suffix: "" });
  assert.deepEqual(hostedTarget(`postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require&sslrootcert=D:/ca.crt`, ref), { suffix: `.${ref}` });
  assert.deepEqual(hostedTarget(`postgresql://postgres.${ref}:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`, ref), { suffix: `.${ref}` });
  const refused = [
    `postgresql://postgres:pw@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres?sslmode=require`, // another project
    `postgresql://postgres.zyxwvutsrqponmlkjihg:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`,
    `postgresql://postgres.${ref}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require`, // transaction pooler
    `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`, // no TLS mode
    `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres?sslmode=disable`,
    `postgresql://app_web_runtime:pw@db.${ref}.supabase.co:5432/postgres?sslmode=require`, // not the bootstrap user
    `postgresql://postgres:pw@db.${ref}.supabase.co:5432/other?sslmode=require`,
    `postgresql://postgres:pw@db.${ref}.supabase.co.evil.test:5432/postgres?sslmode=require`,
    `postgresql://postgres:pw@127.0.0.1:54322/postgres?sslmode=require`,
  ];
  for (const url of refused) assert.throws(() => hostedTarget(url, ref), /does not match SCOPEROOM_SUPABASE_PROJECT_REF/, url);
  assert.throws(() => hostedTarget(`postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres?sslmode=require`, undefined), /20-letter/);
  assert.throws(() => hostedTarget(`postgresql://postgres:pw@db.ABC.supabase.co:5432/postgres?sslmode=require`, "ABC"), /20-letter/);
  assert.throws(() => hostedTarget("not a url", ref), /invalid bootstrap database URL/);
});

test("hostedTarget refuses query parameters that pg or Prisma would let override the pinned host, port or user", () => {
  const pinned = `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`;
  for (const extra of ["&host=db.zyxwvutsrqponmlkjihg.supabase.co", "&port=6543", "&user=postgres", "&options=-c%20role%3Dapp_web", "&sslmode=disable", "&SSLMODE=disable"]) {
    assert.throws(() => hostedTarget(pinned + extra, ref), /only sslmode and sslrootcert/, extra);
  }
});

test("the migration URL must name the verified target, its migration user and, on hosted, the same TLS settings", () => {
  const bootstrap = new URL(`postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require&sslrootcert=D:/ca.crt`);
  const migration = (query: string) => new URL(`postgresql://app_migrator_runtime.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres${query}`);
  assert.equal(migrationTargetMatches(bootstrap, migration("?schema=app&sslmode=require&sslrootcert=D:/ca.crt"), `.${ref}`, true), true);
  for (const query of ["?schema=app", "?schema=app&sslmode=disable&sslrootcert=D:/ca.crt", "?schema=app&sslmode=require", "?schema=app&sslmode=require&sslrootcert=D:/ca.crt&host=127.0.0.1"]) {
    assert.equal(migrationTargetMatches(bootstrap, migration(query), `.${ref}`, true), false, query);
  }
  const local = new URL("postgresql://postgres:pw@127.0.0.1:54322/postgres");
  assert.equal(migrationTargetMatches(local, new URL("postgresql://app_migrator_runtime:pw@127.0.0.1:54322/postgres?schema=app"), "", false), true);
  assert.equal(migrationTargetMatches(local, new URL("postgresql://app_migrator_runtime:pw@127.0.0.1:54322/postgres?schema=app&port=6543"), "", false), false);
});

test("providerGrantProblems names every hosted capability that is not exactly true", async () => {
  const client = { query: async () => ({ rows: [{ create_role: true, anon_admin: true, auth_users_reference: false, realtime_send_public: null }] }) };
  assert.deepEqual(await providerGrantProblems(client), ["auth_users_reference", "realtime_send_public"]);
  let sql = "";
  await providerGrantProblems({ query: async (text: string) => { sql = text; return { rows: [{}] }; } });
  assert.match(sql, /aclexplode\(coalesce\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/, "a NULL ACL means the default PUBLIC EXECUTE");
});

test("the hosted baseline holds back exactly the Auth foreign key, to be re-added unchanged by postgres", () => {
  const source = readFileSync(`prisma/migrations/${BASELINE_MIGRATION}/migration.sql`, "utf8");
  const { sql, constraint } = splitBaselineAuthReference(source);
  assert.equal(constraint, `CONSTRAINT "user_profile_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL`);
  assert.doesNotMatch(sql, /"auth"\./);
  assert.match(sql, /CONSTRAINT "user_profile_display_name_length" CHECK \(char_length\("display_name"\) BETWEEN 1 AND 120\)\r?\n\);/);
  assert.equal(source.length - sql.length, source.match(/,\r?\n\s*CONSTRAINT "user_profile_auth_user_id_fkey"[^\r\n]*/)![0].length);
  assert.throws(() => splitBaselineAuthReference(source + source), /exactly once/);
  assert.throws(() => splitBaselineAuthReference("CREATE TABLE x ();"), /exactly once/);
});
