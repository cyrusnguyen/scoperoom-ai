import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectRef = /^[a-z]{20}$/;
export const BASELINE_MIGRATION = "20260926000000_project_baseline";

/**
 * "local" (the default) or "hosted"; anything else fails closed, so a typo never falls back to the other target's checks.
 * @param {Partial<NodeJS.ProcessEnv>} [env]
 */
export function targetKind(env = process.env) {
  const kind = env.SCOPEROOM_DB_TARGET?.trim() || "local";
  if (kind !== "local" && kind !== "hosted") throw new Error("Database guard needs SCOPEROOM_DB_TARGET to be local or hosted.");
  return kind;
}

/** pg and Prisma let query parameters (host, port, user, options) override the URL itself: allow only the named ones, each once. */
function unsafeParams(url, allowed = ["sslmode", "sslrootcert"]) {
  const keys = [...url.searchParams.keys()];
  return keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length;
}

/** A hosted bootstrap URL must name the configured Supabase project: its direct host or its session pooler, port 5432, with TLS. */
export function hostedTarget(connectionString, ref) {
  if (!projectRef.test(ref ?? "")) throw new Error("Database guard needs a 20-letter SCOPEROOM_SUPABASE_PROJECT_REF.");
  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error("Database guard rejected an invalid bootstrap database URL.");
  }
  if (unsafeParams(target)) throw new Error("Database guard accepts only sslmode and sslrootcert query parameters, each once.");
  const user = decodeURIComponent(target.username);
  const direct = target.hostname === `db.${ref}.supabase.co` && user === "postgres";
  const pooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(target.hostname) && user === `postgres.${ref}`;
  if (!/^postgres(ql)?:$/.test(target.protocol) || !(direct || pooler) || target.port !== "5432" || target.pathname !== "/postgres"
    || !["require", "verify-ca", "verify-full"].includes(target.searchParams.get("sslmode") ?? "")) {
    throw new Error("Database guard rejected a hosted target that does not match SCOPEROOM_SUPABASE_PROJECT_REF.");
  }
  return { suffix: pooler ? `.${ref}` : "" };
}

// Hosted Supabase has no supabase_admin, and its postgres cannot pass on Auth grants (Stage 12a Task 1, 2026-10-12). Instead: app_migrator and the
// Realtime reader join anon (postgres holds ADMIN on it; anon reads auth), PUBLIC already executes realtime.send and the Auth functions, and postgres
// adds the one auth.users foreign key itself. Realtime grants pass on directly.
const PROVIDER_GRANTS = `select
  (select rolcreaterole from pg_roles where rolname = current_user) as create_role,
  pg_has_role('anon', 'MEMBER WITH ADMIN OPTION') as anon_admin,
  has_schema_privilege('anon', 'auth', 'USAGE') and has_function_privilege('anon', 'auth.uid()', 'EXECUTE') and has_function_privilege('anon', 'auth.jwt()', 'EXECUTE') as anon_auth,
  has_column_privilege('auth.users', 'id', 'REFERENCES') as auth_users_reference,
  has_schema_privilege('realtime', 'USAGE WITH GRANT OPTION') as realtime_usage,
  has_table_privilege('realtime.messages', 'SELECT WITH GRANT OPTION') as realtime_select,
  has_table_privilege('realtime.messages', 'INSERT WITH GRANT OPTION') as realtime_insert,
  exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'realtime.send(jsonb,text,text,boolean)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as realtime_send_public`;

/** The migration URL names the verified bootstrap target and its migration login; hosted, it also carries the same TLS settings. */
export function migrationTargetMatches(bootstrap, migration, suffix, hosted) {
  const tls = (url) => `${url.searchParams.get("sslmode")}|${url.searchParams.get("sslrootcert")}`;
  return migration.protocol === bootstrap.protocol && migration.hostname === bootstrap.hostname && migration.port === bootstrap.port && migration.pathname === bootstrap.pathname
    && decodeURIComponent(migration.username) === `app_migrator_runtime${suffix}` && !unsafeParams(migration, ["sslmode", "sslrootcert", "schema"])
    && (!hosted || tls(migration) === tls(bootstrap));
}

export async function providerGrantProblems(client) {
  const { rows: [row] } = await client.query(PROVIDER_GRANTS);
  return Object.entries(row).filter(([, granted]) => granted !== true).map(([name]) => name);
}

/** Provider-owned grants. Local: supabase_admin inside the exact container. Hosted: postgres, after providerGrantProblems passed at --initial. */
export async function providerSql(client, sql) {
  if (targetKind() === "hosted") {
    await client.query(sql);
    return;
  }
  const { projectId, dbPort } = localConfig();
  const { docker } = inspectLocalContainer(projectId, dbPort);
  execFileSync(docker, ["exec", `supabase_db_${projectId}`, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: ["ignore", "ignore", "inherit"] });
}

/** The baseline without its single auth.users foreign key, and that constraint clause verbatim (hosted bootstrap re-adds it as postgres). */
export function splitBaselineAuthReference(source) {
  const matches = [...source.matchAll(/,\r?\n\s*(CONSTRAINT "user_profile_auth_user_id_fkey" FOREIGN KEY \("auth_user_id"\) REFERENCES "auth"\."users"\("id"\) ON DELETE SET NULL)/g)];
  if (matches.length !== 1) throw new Error("Database guard needs the baseline Auth foreign key exactly once.");
  const [{ 0: whole, 1: constraint, index }] = matches;
  return { sql: source.slice(0, index) + source.slice(index + whole.length), constraint };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Database guard needs ${name}.`);
  return value;
}

export function localConfig(configPath = process.env.SCOPEROOM_SUPABASE_CONFIG ?? new URL("../../supabase/config.toml", import.meta.url)) {
  const config = readFileSync(configPath, "utf8");
  const projectId = config.split(/^\s*\[/m)[0].match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  const dbSection = config.match(/^\[db\][^\S\r\n]*(?:#[^\r\n]*)?\r?\n([\s\S]*)/m)?.[1]?.split(/^\s*\[/m)[0];
  const dbPort = dbSection?.match(/^port\s*=\s*(\d+)/m)?.[1];
  if (!projectId || !dbPort) throw new Error("Database guard could not read local Supabase project configuration.");
  return { dbPort, projectId };
}

/** Verifies a local Supabase service container by CLI project label and loopback-only network; the database also needs its loopback port binding. */
export function inspectLocalContainer(projectId, dbPort, service = "db") {
  const binaries = [process.env.SCOPEROOM_DOCKER_BIN, "docker", "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"].filter(Boolean);
  let inspected;
  let selectedDocker;
  for (const docker of binaries) {
    try {
      inspected = JSON.parse(execFileSync(docker, ["inspect", `supabase_${service}_${projectId}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
      selectedDocker = docker;
      break;
    } catch {}
  }
  if (!inspected || inspected.Config?.Labels?.["com.supabase.cli.project"] !== projectId) {
    throw new Error("Database guard could not verify the configured local Supabase database container.");
  }
  const bindings = inspected.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
  const loopbackPort = service !== "db" || bindings.some((binding) => binding.HostIp === "127.0.0.1" && binding.HostPort === dbPort);
  const loopbackNetworks = Object.keys(inspected.NetworkSettings?.Networks ?? {}).filter((network) => {
    try {
      const details = JSON.parse(execFileSync(selectedDocker, ["network", "inspect", network], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
      return details.Options?.["com.docker.network.bridge.host_binding_ipv4"] === "127.0.0.1";
    } catch {
      return false;
    }
  });
  if (!loopbackPort || loopbackNetworks.length === 0) throw new Error("Database guard rejected a non-loopback local Supabase database binding.");
  return { docker: selectedDocker, container: inspected, loopbackNetworks };
}

export function targetInput() {
  const connectionString = required("SCOPEROOM_BOOTSTRAP_DATABASE_URL");
  const expected = required("SCOPEROOM_ENVIRONMENT_ID");
  if (!uuid.test(expected)) throw new Error("Database guard needs a UUID SCOPEROOM_ENVIRONMENT_ID.");
  if (targetKind() === "hosted") return { connectionString, expected, ...hostedTarget(connectionString, process.env.SCOPEROOM_SUPABASE_PROJECT_REF) };
  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error("Database guard rejected an invalid bootstrap database URL.");
  }
  const { dbPort, projectId } = localConfig();
  if (!/^postgres(ql)?:$/.test(target.protocol) || unsafeParams(target) || !["127.0.0.1", "[::1]", "::1"].includes(target.hostname) || target.port !== dbPort || target.pathname !== "/postgres") {
    throw new Error("Database guard rejected a non-local Supabase database target.");
  }
  inspectLocalContainer(projectId, dbPort);
  return { connectionString, expected, suffix: "" };
}

export async function verifyTarget(mode = "bound") {
  const { connectionString, expected } = targetInput();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (mode === "initial") {
      const { rows: [target] } = await client.query("select to_regnamespace('app') is null as empty_target");
      if (!target.empty_target) throw new Error("Database guard rejected a nonempty initial target.");
      if (targetKind() === "hosted") {
        const missing = await providerGrantProblems(client);
        if (missing.length) throw new Error(`Hosted target lacks provider capabilities: ${missing.join(", ")}.`);
      }
    } else if (mode === "bind") {
      const { rows: [target] } = await client.query("select count(*)::int as count from app.environment_identity");
      if (target.count !== 0) throw new Error("Database guard rejected an already bound environment target.");
      await client.query("insert into app.environment_identity(id, environment_id) values (1, $1)", [expected]);
    } else {
      const { rows: [target] } = await client.query("select environment_id::text as environment_id from app.environment_identity where id = 1");
      if (!target || target.environment_id !== expected) throw new Error("Database guard rejected environment identity.");
    }
  } finally {
    await client.end();
  }
}

async function verifyMigrationTarget() {
  const { suffix } = targetInput();
  const migrationUrl = required("MIGRATION_DATABASE_URL");
  const bootstrap = new URL(required("SCOPEROOM_BOOTSTRAP_DATABASE_URL"));
  const migration = new URL(migrationUrl);
  if (!migrationTargetMatches(bootstrap, migration, suffix, targetKind() === "hosted")) {
    throw new Error("Database guard rejected a migration target that differs from the verified bootstrap target.");
  }
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const { rows: [role] } = await client.query("select current_user, session_user, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user");
    if (!role || role.current_user !== "app_migrator" || role.session_user !== "app_migrator_runtime" || role.rolsuper || role.rolbypassrls) {
      throw new Error("Database guard rejected an unscoped migration role.");
    }
  } finally {
    await client.end();
  }
}

async function provisionRuntimeRoles() {
  await verifyTarget("initial");
  const { connectionString } = targetInput();
  const roles = [
    ["app_migrator_runtime", "app_migrator", required("SCOPEROOM_MIGRATOR_PASSWORD")],
    ["app_web_runtime", "app_web", required("SCOPEROOM_WEB_RUNTIME_PASSWORD")],
    ["app_worker_runtime", "app_worker", required("SCOPEROOM_WORKER_RUNTIME_PASSWORD")],
  ];
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Hosted targets never run the local seed; creating the same nologin group roles here is idempotent locally.
    await client.query(readFileSync(new URL("../../supabase/seed.sql", import.meta.url), "utf8"));
    await client.query("create schema if not exists app authorization app_migrator");
    for (const [login, group, password] of roles) {
      const { rows: [{ literal }] } = await client.query("select quote_literal($1) as literal", [password]);
      await client.query(`do $$ begin create role ${login} login noinherit nosuperuser nocreatedb nocreaterole noreplication password ${literal}; exception when duplicate_object then null; end $$`);
      await client.query(`grant ${group} to ${login}`);
      await client.query(`alter role ${login} set role ${group}`);
    }
  } finally {
    await client.end();
  }
}

async function provisionMigrationAuthReference() {
  const { connectionString } = targetInput();
  const hosted = targetKind() === "hosted";
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Supabase owns auth: locally supabase_admin delegates both grants. Hosted, app_migrator reads auth through anon and postgres adds the
    // auth.users foreign key itself (--hosted-baseline).
    await providerSql(client, hosted ? "GRANT anon TO app_migrator WITH INHERIT TRUE, SET FALSE;" : "GRANT USAGE ON SCHEMA auth TO app_migrator; GRANT REFERENCES (id) ON auth.users TO app_migrator;");
    const { rows: [access] } = await client.query("select has_schema_privilege('app_migrator', 'auth', 'USAGE') as schema_usage, has_column_privilege('app_migrator', 'auth.users', 'id', 'REFERENCES') as user_reference");
    if (!access.schema_usage || (!hosted && !access.user_reference)) throw new Error("Migration role cannot reference the managed Auth user key.");
  } finally {
    await client.end();
  }
}

/**
 * Hosted only, before the first Prisma deploy: one transaction creates the baseline as app_migrator without its auth.users foreign key, then
 * postgres (which holds REFERENCES but cannot pass it on) adds that constraint verbatim. bootstrap.mjs then records the baseline as applied.
 */
async function applyHostedBaseline() {
  if (targetKind() !== "hosted") throw new Error("Database guard applies the split baseline only to a hosted target.");
  const { connectionString } = targetInput();
  const { sql, constraint } = splitBaselineAuthReference(readFileSync(new URL(`../../prisma/migrations/${BASELINE_MIGRATION}/migration.sql`, import.meta.url), "utf8"));
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: [state] } = await client.query("select to_regclass('app._prisma_migrations') is null and to_regclass('app.environment_identity') is null as fresh");
    if (!state.fresh) throw new Error("Database guard applies the hosted baseline only before any migration.");
    await client.query("begin");
    try {
      await client.query("set local role app_migrator");
      await client.query("set local search_path = app"); // as Prisma's schema=app connection
      await client.query(sql);
      await client.query("reset role");
      await client.query(`alter table "app"."user_profile" add ${constraint}`);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
const mode = process.argv.includes("--initial") ? "initial" : process.argv.includes("--bind") ? "bind" : "bound";
if (process.argv.includes("--provision-runtime")) await provisionRuntimeRoles();
else if (process.argv.includes("--provision-migration-auth-reference")) await provisionMigrationAuthReference();
else if (process.argv.includes("--hosted-baseline")) await applyHostedBaseline();
else if (process.argv.includes("--migration")) await verifyMigrationTarget();
else await verifyTarget(mode);
console.log(`target=verified-${targetKind()}`);
}
