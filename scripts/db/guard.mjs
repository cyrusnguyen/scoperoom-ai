import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Database guard needs ${name}.`);
  return value;
}

function localConfig() {
  const config = readFileSync(process.env.SCOPEROOM_SUPABASE_CONFIG ?? new URL("../../supabase/config.toml", import.meta.url), "utf8");
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  const dbPort = config.match(/^\[db\][\s\S]*?^port\s*=\s*(\d+)/m)?.[1];
  if (!projectId || !dbPort) throw new Error("Database guard could not read local Supabase project configuration.");
  return { dbPort, projectId };
}

function inspectLocalContainer(projectId, dbPort) {
  const binaries = [process.env.SCOPEROOM_DOCKER_BIN, "docker", "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"].filter(Boolean);
  let inspected;
  let selectedDocker;
  for (const docker of binaries) {
    try {
      inspected = JSON.parse(execFileSync(docker, ["inspect", `supabase_db_${projectId}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
      selectedDocker = docker;
      break;
    } catch {}
  }
  if (!inspected || inspected.Config?.Labels?.["com.supabase.cli.project"] !== projectId) {
    throw new Error("Database guard could not verify the configured local Supabase database container.");
  }
  const bindings = inspected.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
  const loopbackPort = bindings.some((binding) => binding.HostIp === "127.0.0.1" && binding.HostPort === dbPort);
  const loopbackNetwork = Object.keys(inspected.NetworkSettings?.Networks ?? {}).some((network) => {
    try {
      const details = JSON.parse(execFileSync(selectedDocker, ["network", "inspect", network], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
      return details.Options?.["com.docker.network.bridge.host_binding_ipv4"] === "127.0.0.1";
    } catch {
      return false;
    }
  });
  if (!loopbackPort || !loopbackNetwork) throw new Error("Database guard rejected a non-loopback local Supabase database binding.");
  return selectedDocker;
}

function targetInput() {
  const connectionString = required("SCOPEROOM_BOOTSTRAP_DATABASE_URL");
  const expected = required("SCOPEROOM_ENVIRONMENT_ID");
  if (!uuid.test(expected)) throw new Error("Database guard needs a UUID SCOPEROOM_ENVIRONMENT_ID.");
  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error("Database guard rejected an invalid bootstrap database URL.");
  }
  const { dbPort, projectId } = localConfig();
  if (!/^postgres(ql)?:$/.test(target.protocol) || !["127.0.0.1", "[::1]", "::1"].includes(target.hostname) || target.port !== dbPort || target.pathname !== "/postgres") {
    throw new Error("Database guard rejected a non-local Supabase database target.");
  }
  inspectLocalContainer(projectId, dbPort);
  return { connectionString, expected };
}

export async function verifyTarget(mode = "bound") {
  const { connectionString, expected } = targetInput();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (mode === "initial") {
      const { rows: [target] } = await client.query("select to_regnamespace('app') is null as empty_target");
      if (!target.empty_target) throw new Error("Database guard rejected a nonempty initial target.");
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
  targetInput();
  const migrationUrl = required("MIGRATION_DATABASE_URL");
  const bootstrap = new URL(required("SCOPEROOM_BOOTSTRAP_DATABASE_URL"));
  const migration = new URL(migrationUrl);
  if (migration.protocol !== bootstrap.protocol || migration.hostname !== bootstrap.hostname || migration.port !== bootstrap.port || migration.pathname !== bootstrap.pathname || migration.username !== "app_migrator_runtime") {
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
  const { projectId, dbPort } = localConfig();
  const docker = inspectLocalContainer(projectId, dbPort);
  // Supabase owns auth.users; local postgres cannot delegate this grant.
  execFileSync(docker, ["exec", `supabase_db_${projectId}`, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "GRANT USAGE ON SCHEMA auth TO app_migrator; GRANT REFERENCES (id) ON auth.users TO app_migrator;"]);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: [access] } = await client.query("select has_schema_privilege('app_migrator', 'auth', 'USAGE') as schema_usage, has_column_privilege('app_migrator', 'auth.users', 'id', 'REFERENCES') as user_reference");
    if (!access.schema_usage || !access.user_reference) throw new Error("Migration role cannot reference the managed Auth user key.");
  } finally {
    await client.end();
  }
}

const mode = process.argv.includes("--initial") ? "initial" : process.argv.includes("--bind") ? "bind" : "bound";
if (process.argv.includes("--provision-runtime")) await provisionRuntimeRoles();
else if (process.argv.includes("--provision-migration-auth-reference")) await provisionMigrationAuthReference();
else if (process.argv.includes("--migration")) await verifyMigrationTarget();
else await verifyTarget(mode);
console.log("target=verified-local");
