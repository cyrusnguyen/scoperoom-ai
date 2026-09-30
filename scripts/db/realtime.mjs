import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { inspectLocalContainer, localConfig, targetInput, verifyTarget } from "./guard.mjs";

// Guarded operator setup for private Realtime (Stage 04.1). Idempotent configuration, not a second migration ledger:
//   prepare  before Prisma deploy: fixed roles and the app_private schema (owned by app_migrator)
//   apply    after deploy: helper ownership/privileges, browser grants, provider policies, private-only tenant
//   verify   read-only assertion of everything above
const READER = "app_realtime_reader";
const NOTIFIER = "app_realtime_notifier";
const HELPER = "app_private.can_realtime(text,text)";
const ADAPTER = "app_private.enqueue_project_hint(jsonb,text)";
const TRIGGER_FN = "app_private.notify_project_changed()";
const OWNED = [[HELPER, READER], [ADAPTER, NOTIFIER], [TRIGGER_FN, NOTIFIER]]; // function -> restricted owner
// md5 of each body with whitespace collapsed and trimmed (matches the migration source). A deliberate body change updates the constant in the same PR.
const BODY_MD5 = { [HELPER]: "22006d3ee045a46dda7f71d8c07ff5dd", [ADAPTER]: "40fe2880c0393d55e06747fe6b8fb7d4", [TRIGGER_FN]: "835571f242df0171811a5a42c7f7c683" };
const BODY = "md5(trim(regexp_replace(p.prosrc, '\\s+', ' ', 'g')))";
const HINT_TOPIC = "^project:[0-9a-f-]{36}:[0-9a-f-]{36}:events$";
const TENANT = "realtime-dev"; // fixed external id of the local Supabase CLI tenant
const TENANT_WAIT_MS = 60_000;
const ROLE_ATTRIBUTES = "nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls";
const POLICIES = {
  scoperoom_rt_select: `create policy scoperoom_rt_select on realtime.messages for select to authenticated using (
    (extension = 'broadcast' and app_private.can_realtime((select realtime.topic()), 'receive_broadcast'))
    or (extension = 'presence' and app_private.can_realtime((select realtime.topic()), 'presence')))`,
  scoperoom_rt_insert: `create policy scoperoom_rt_insert on realtime.messages for insert to authenticated with check (
    (extension = 'broadcast' and app_private.can_realtime((select realtime.topic()), 'send_broadcast'))
    or (extension = 'presence' and app_private.can_realtime((select realtime.topic()), 'presence')))`,
  // The notifier is not a table owner, so provider row level security applies to its realtime.send insert: allow exactly the hint shape.
  scoperoom_rt_hint: `create policy scoperoom_rt_hint on realtime.messages for insert to ${NOTIFIER} with check (
    extension = 'broadcast' and private and event = 'PROJECT_CHANGED' and topic ~ '${HINT_TOPIC}')`,
};

/** Runs statements as the provider superuser inside the exact local database container (postgres cannot delegate provider grants). */
function providerSql(sql) {
  const { projectId, dbPort } = localConfig();
  const { docker } = inspectLocalContainer(projectId, dbPort);
  execFileSync(docker, ["exec", `supabase_db_${projectId}`, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: ["ignore", "ignore", "inherit"] });
}

/** Calls the local Realtime tenant API inside the exact loopback container; the management secret never leaves memory. */
function tenantApi() {
  const { projectId, dbPort } = localConfig();
  const { docker, container } = inspectLocalContainer(projectId, dbPort, "realtime");
  const secret = container.Config?.Env?.find((entry) => entry.startsWith("API_JWT_SECRET="))?.slice("API_JWT_SECRET=".length);
  if (!secret) throw new Error("Realtime setup could not read the local management credential.");
  return (method, body) => requestLocalTenant({ docker, projectId, secret, method, body });
}

/**
 * Bounded local adapter. Injected process/time calls exercise slow startup without changing provider state.
 * @param {{ docker: string, projectId: string, secret: string, method: string, body?: unknown }} target
 * @param {{ run?: (binary: string, args: string[], options: { encoding: "utf8", input: string, stdio: ["pipe", "pipe", "ignore"] }) => string, now?: () => number, wait?: (ms: number) => void }} dependencies
 */
export function requestLocalTenant({ docker, projectId, secret, method, body = undefined }, {
  run = execFileSync, now = Date.now,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const args = ["exec", "-i", `supabase_realtime_${projectId}`, "curl", "-sS", "--max-time", "15", "-K", "-", "-w", "\n%{http_code}", "-H", "content-type: application/json"];
  if (method === "PUT") args.push("-X", "PUT", "-d", JSON.stringify(body));
  // A freshly started Realtime container may not accept connections yet (CI): retry until the deadline, then fail closed.
  for (const deadline = now() + TENANT_WAIT_MS; ; ) {
    // A slow container may become reachable only after the first credential expires.
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role", exp: Math.floor(now() / 1000) + 60 })}`;
    const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
    let output;
    try {
      output = run(docker, [...args, `http://127.0.0.1:4000/api/tenants/${TENANT}`], { encoding: "utf8", input: `header = "Authorization: Bearer ${token}"\n`, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      if (now() >= deadline) throw new Error(`Realtime setup could not reach the local tenant API within ${TENANT_WAIT_MS / 1000}s.`);
      wait(2000);
      continue;
    }
    const split = output.lastIndexOf("\n");
    // Bodies hold encrypted provider settings, so they are parsed here and never printed.
    return { status: Number(output.slice(split + 1)), data: (() => { try { return JSON.parse(output.slice(0, split)).data; } catch { return undefined; } })() };
  }
}

async function requirePrivateOnly(configure) {
  const api = tenantApi();
  let tenant = api("GET");
  if (tenant.status !== 200) throw new Error(`Realtime setup found no local tenant (status ${tenant.status}).`);
  if (configure && tenant.data?.private_only !== true) {
    const update = api("PUT", { tenant: { private_only: true } });
    if (update.status !== 200) throw new Error(`Realtime setup could not enable private-only access (status ${update.status}).`);
    tenant = api("GET");
  }
  if (tenant.status !== 200 || tenant.data?.private_only !== true) throw new Error("Realtime tenant still allows public channels.");
}

async function prepare(client) {
  for (const role of [READER, NOTIFIER]) {
    await client.query(`do $$ begin create role ${role} ${ROLE_ATTRIBUTES}; exception when duplicate_object then null; end $$`);
  }
  await client.query("create schema if not exists app_private authorization app_migrator");
  const { rows: [schema] } = await client.query("select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'app_private'");
  if (schema.owner !== "app_migrator") throw new Error("Realtime setup found app_private with an unexpected owner.");
}

/** Provider RLS must already be on, and no unrelated permissive policy may widen browser access to realtime.messages. */
async function requireProviderTable(client) {
  const { rows: [table] } = await client.query("select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass");
  if (!table?.relrowsecurity) throw new Error("Realtime setup expected provider row level security on realtime.messages.");
  const { rows: foreign } = await client.query(`
    select polname from pg_policy where polrelid = 'realtime.messages'::regclass and polpermissive and polname <> all($1)
      and (0 = any(polroles) or 'authenticated'::regrole::oid = any(polroles) or 'anon'::regrole::oid = any(polroles))`, [Object.keys(POLICIES)]);
  if (foreign.length) throw new Error(`Realtime setup found unrelated policies on realtime.messages: ${foreign.map((row) => row.polname).join(", ")}. Review them before continuing.`);
}

async function helperProblems(client) {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const { rows: roles } = await client.query(`select rolname, rolsuper, rolinherit, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname in ('${READER}', '${NOTIFIER}')`);
  expect(roles.length === 2, "restricted Realtime roles are missing");
  for (const role of roles) expect(!(role.rolsuper || role.rolinherit || role.rolcanlogin || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.rolreplication), `${role.rolname} has unexpected attributes`);
  const { rows: members } = await client.query(`select 1 from pg_auth_members where roleid in ('${READER}'::regrole, '${NOTIFIER}'::regrole) and (member <> 'postgres'::regrole or inherit_option or set_option)`); // postgres keeps only the ADMIN option it received as creator
  expect(members.length === 0, "restricted Realtime roles must not be usable by any other role");
  const { rows: [fn] } = await client.query(`
    select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.provolatile, p.prorettype = 'boolean'::regtype as boolean_only, l.lanname, p.proconfig, ${BODY} as body,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee not in (p.proowner, 'authenticated'::regrole)) as shared
    from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('${HELPER}')`);
  expect(fn, "the Realtime helper is missing");
  if (fn) {
    expect(fn.owner === READER, "the Realtime helper is not owned by the restricted reader");
    expect(fn.prosecdef && fn.provolatile === "s" && fn.boolean_only && fn.lanname === "sql", "the Realtime helper is not a stable boolean SQL SECURITY DEFINER function");
    expect(fn.proconfig?.length === 1 && fn.proconfig[0] === 'search_path=""', "the Realtime helper does not pin an empty search_path");
    expect(fn.body === BODY_MD5[HELPER], `${HELPER} body differs from the migration`);
    expect(!fn.shared, `${HELPER} is executable by a role other than its owner and authenticated`);
  }
  // The hint adapter and trigger function: notifier-owned SECURITY DEFINER plpgsql, empty search path, executable by nobody else.
  for (const [signature, kind] of [[ADAPTER, "void"], [TRIGGER_FN, "trigger"]]) {
    const { rows: [hint] } = await client.query(`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.prorettype = '${kind}'::regtype as returns_kind, l.lanname, p.proconfig, ${BODY} as body,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> p.proowner) as shared,
        (select bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) from unnest(array['authenticated', 'anon', 'app_web', 'app_worker', 'app_web_runtime', 'app_worker_runtime', 'app_migrator_runtime', '${READER}']) as r) as roles_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('${signature}')`);
    expect(hint, `${signature} is missing`);
    if (!hint) continue;
    expect(hint.owner === NOTIFIER, `${signature} is not owned by the restricted notifier`);
    expect(hint.prosecdef && hint.returns_kind && hint.lanname === "plpgsql", `${signature} is not a SECURITY DEFINER plpgsql ${kind} function`);
    expect(hint.proconfig?.length === 1 && hint.proconfig[0] === 'search_path=""', `${signature} does not pin an empty search_path`);
    expect(hint.body === BODY_MD5[signature], `${signature} body differs from the migration`);
    expect(!hint.shared && !hint.roles_execute, `${signature} is executable by PUBLIC or another role`);
  }
  const { rows: triggers } = await client.query(`
    select t.tgenabled, regexp_replace(pg_get_triggerdef(t.oid), '\\s+', ' ', 'g') as definition
    from pg_trigger t where t.tgrelid = 'app.project'::regclass and not t.tgisinternal and t.tgfoid = to_regprocedure('${TRIGGER_FN}')`);
  expect(triggers.length === 1 && triggers[0].tgenabled === "O" && triggers[0].definition === "CREATE TRIGGER project_changed_hint AFTER UPDATE OF event_sequence ON app.project FOR EACH ROW WHEN ((new.event_sequence > old.event_sequence)) EXECUTE FUNCTION app_private.notify_project_changed()",
    "the project change trigger is missing, disabled or differs");
  const { rows: [access] } = await client.query(`
    select
      (select count(*)::int from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and has_column_privilege('${READER}', c.oid, a.attnum, 'SELECT')) as reader_columns,
      exists (select 1 from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind = 'r'
        and (has_table_privilege('${READER}', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege('${READER}', c.oid, 'INSERT,UPDATE,REFERENCES'))) as reader_writes,
      has_schema_privilege('${READER}', 'auth', 'USAGE') and has_function_privilege('${READER}', 'auth.uid()', 'EXECUTE') and has_function_privilege('${READER}', 'auth.jwt()', 'EXECUTE') as reader_auth,
      has_schema_privilege('${NOTIFIER}', 'realtime', 'USAGE') and has_function_privilege('${NOTIFIER}', 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE')
        and has_schema_privilege('${NOTIFIER}', 'app_private', 'USAGE') and has_table_privilege('${NOTIFIER}', 'realtime.messages', 'INSERT') as notifier_send,
      has_schema_privilege('${NOTIFIER}', 'app', 'USAGE') or has_table_privilege('${NOTIFIER}', 'realtime.messages', 'SELECT,UPDATE,DELETE') or has_function_privilege('${NOTIFIER}', '${HELPER}', 'EXECUTE') as notifier_reads,
      exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure('${HELPER}') and a.grantee = 0) as helper_public,
      bool_or(has_function_privilege(r, '${HELPER}', 'EXECUTE') or has_schema_privilege(r, 'app_private', 'USAGE')) as others_reach_helper
    from unnest(array['anon', 'app_web', 'app_worker', 'app_web_runtime', 'app_worker_runtime', 'app_migrator_runtime']) as r`);
  expect(access.reader_columns === 10, "the reader has an unexpected column SELECT set");
  expect(!access.reader_writes, "the reader can write application tables");
  expect(access.reader_auth, "the reader cannot call the Auth functions");
  expect(access.notifier_send, "the notifier cannot enqueue Realtime hints");
  expect(!access.notifier_reads, "the notifier can reach application data, the helper or provider messages beyond inserting hints");
  expect(!access.helper_public && !access.others_reach_helper, "the helper is reachable by PUBLIC or a non-browser role");
  return problems;
}

async function browserProblems(client) {
  const problems = [];
  const { rows: [access] } = await client.query(`
    select has_schema_privilege('authenticated', 'app_private', 'USAGE') and has_function_privilege('authenticated', '${HELPER}', 'EXECUTE') as helper,
      has_schema_privilege('authenticated', 'app', 'USAGE') or has_schema_privilege('anon', 'app', 'USAGE') as app_schema,
      exists (select 1 from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and (has_table_privilege('authenticated', c.oid, 'SELECT') or has_any_column_privilege('authenticated', c.oid, 'SELECT'))) as app_tables`);
  if (!access.helper) problems.push("authenticated cannot execute the Realtime helper");
  if (access.app_schema || access.app_tables) problems.push("authenticated can reach application data");
  const { rows: [table] } = await client.query("select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass");
  if (!table?.relrowsecurity) problems.push("provider row level security is off on realtime.messages");
  const { rows: policies } = await client.query(`select policyname::text, cmd::text, roles::text[] as roles, regexp_replace(coalesce(qual, with_check), '\\s+', ' ', 'g') as expression from pg_policies where schemaname = 'realtime' and tablename = 'messages' order by policyname`);
  const expected = {
    scoperoom_rt_select: ["SELECT", "(((extension = 'broadcast'::text) AND app_private.can_realtime(( SELECT realtime.topic() AS topic), 'receive_broadcast'::text)) OR ((extension = 'presence'::text) AND app_private.can_realtime(( SELECT realtime.topic() AS topic), 'presence'::text)))"],
    scoperoom_rt_insert: ["INSERT", "(((extension = 'broadcast'::text) AND app_private.can_realtime(( SELECT realtime.topic() AS topic), 'send_broadcast'::text)) OR ((extension = 'presence'::text) AND app_private.can_realtime(( SELECT realtime.topic() AS topic), 'presence'::text)))"],
    scoperoom_rt_hint: ["INSERT", `((extension = 'broadcast'::text) AND private AND (event = 'PROJECT_CHANGED'::text) AND (topic ~ '${HINT_TOPIC}'::text))`, NOTIFIER],
  };
  for (const [name, [cmd, expression, role = "authenticated"]] of Object.entries(expected)) {
    const policy = policies.find((row) => row.policyname === name);
    if (!policy || policy.cmd !== cmd || policy.roles.join() !== role || policy.expression !== expression) problems.push(`policy ${name} is missing or differs`);
  }
  return problems;
}

/** Moves a function to its restricted owner. Only this transaction may use the owner role (or create in the schema), and never afterwards. */
async function transferOwner(client, signature, owner) {
  const { rows: [fn] } = await client.query(`select pg_get_userbyid(proowner) as owner from pg_proc where oid = '${signature}'::regprocedure`);
  if (fn.owner === owner) return;
  await client.query("begin");
  try {
    await client.query(`grant ${owner} to current_user with inherit true, set true`);
    await client.query(`grant create on schema app_private to ${owner}`);
    await client.query(`alter function ${signature} owner to ${owner}`);
    await client.query(`revoke create on schema app_private from ${owner}`);
    await client.query(`revoke ${owner} from current_user`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function apply(client) {
  if (!(await client.query(`select to_regprocedure('${HELPER}') as fn, to_regprocedure('${ADAPTER}') as adapter, to_regprocedure('${TRIGGER_FN}') as trigger`)).rows.every((row) => row.fn && row.adapter && row.trigger)) throw new Error("Realtime setup needs the private Realtime migration applied first.");
  await requireProviderTable(client);
  providerSql(`GRANT USAGE ON SCHEMA auth TO ${READER}; GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO ${READER}; GRANT USAGE ON SCHEMA realtime TO ${NOTIFIER}; GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO ${NOTIFIER}; GRANT INSERT ON realtime.messages TO ${NOTIFIER};`);
  await client.query(`
    grant usage on schema app to ${READER};
    grant usage on schema app_private to ${NOTIFIER};
    grant usage on type app.project_status, app.project_member_role to ${READER};
    grant select (id, owner_id, status, realtime_epoch) on app.project to ${READER};
    grant select (id, auth_user_id) on app.user_profile to ${READER};
    grant select (project_id, profile_id, active, role) on app.project_membership to ${READER}`);
  for (const [signature, owner] of OWNED) await transferOwner(client, signature, owner);
  const problems = await helperProblems(client);
  if (problems.length) throw new Error(`Realtime helper verification failed: ${problems.join("; ")}.`);
  // Only after the helper is verified do browsers get access and the provider policies appear.
  await client.query("begin");
  try {
    await client.query("grant usage on schema app_private to authenticated");
    await client.query(`grant ${READER} to current_user with inherit true, set true`);
    await client.query(`grant execute on function ${HELPER} to authenticated`);
    await client.query(`revoke ${READER} from current_user`);
    for (const [name, create] of Object.entries(POLICIES)) {
      await client.query(`drop policy if exists ${name} on realtime.messages`);
      await client.query(create);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  await requirePrivateOnly(true);
}

async function verify(client) {
  await requireProviderTable(client);
  const problems = [...(await helperProblems(client)), ...(await browserProblems(client))];
  if (problems.length) throw new Error(`Realtime verification failed: ${problems.join("; ")}.`);
  await requirePrivateOnly(false);
}

if (import.meta.main) {
  const command = process.argv[2];
  const steps = { prepare, apply, verify };
  if (!steps[command]) throw new Error("Usage: realtime.mjs prepare [--initial] | apply | verify");
  // A fresh bootstrap has no bound identity yet; guard.mjs --initial already verified the empty loopback target in this run.
  let connectionString;
  if (command === "prepare" && process.argv.includes("--initial")) ({ connectionString } = targetInput());
  else {
    await verifyTarget("bound");
    ({ connectionString } = targetInput());
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await steps[command](client);
  } finally {
    await client.end();
  }
  console.log(`realtime=${command}-ok`);
}
