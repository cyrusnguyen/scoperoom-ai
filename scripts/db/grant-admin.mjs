import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { targetInput, verifyTarget } from "./guard.mjs";

// Operator only, once per target: grants the FIRST Admin role to the account that signed in with this email. Every later role change
// happens in the Admin screen (app.admin_set_role, Admin only, audited). It refuses while any active Admin exists, writes the role and
// one account audit row in one transaction, and prints only the profile id prefix.
//   node --env-file=.env.hosted.local scripts/db/grant-admin.mjs <email>

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function parseEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Usage: grant-admin.mjs <email of an account that has signed in once>");
  return email;
}

/** Grants the first Admin on a connection that can read auth.users (the bootstrap `postgres` role). Returns the profile id. */
export async function grantFirstAdmin(client, email) {
  await client.query("BEGIN");
  try {
    // The same transaction lock app.admin_set_role takes: serialises with role changes and with a second run of this script.
    await client.query("select pg_advisory_xact_lock(hashtextextended('app.platform_role', 0))");
    const { rows: [admins] } = await client.query("select count(*)::int as n from app.platform_role where role = 'ADMIN' and revoked_at is null");
    if (admins.n > 0) throw new Error("An Admin already exists: grant roles from the Admin screen instead.");
    const { rows } = await client.query(
      `select p.id from app.user_profile p join auth.users u on u.id = p.auth_user_id
       where lower(u.email) = $1 and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)`, [email]);
    if (rows.length !== 1) throw new Error("No ScopeRoom account for that email: sign in to the app once first.");
    const profileId = rows[0].id;
    const { rows: [before] } = await client.query("select role from app.platform_role where profile_id = $1 and revoked_at is null", [profileId]);
    await client.query(
      `insert into app.platform_role (profile_id, role, granted_by) values ($1, 'ADMIN', $1)
       on conflict (profile_id) do update set role = 'ADMIN', granted_by = $1, granted_at = clock_timestamp(), revoked_at = null, version = app.platform_role.version + 1`,
      [profileId]);
    await client.query(
      `insert into app.account_audit_event (actor_id, target_profile_id, action, before, after, reason, request_id)
       values ($1, $1, 'ROLE_SET', $2, $3, 'First Admin granted by the operator script', $4)`,
      [profileId, JSON.stringify({ role: before?.role ?? null }), JSON.stringify({ role: "ADMIN" }), randomUUID()]);
    await client.query("COMMIT");
    return profileId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  const email = parseEmail(process.argv[2]);
  await verifyTarget("bound");
  const client = new Client({ connectionString: targetInput().connectionString });
  await client.connect();
  try {
    const profileId = await grantFirstAdmin(client, email);
    console.log(`grant-admin=ok profile=${profileId.slice(0, 8)}`);
  } finally {
    await client.end();
  }
}
