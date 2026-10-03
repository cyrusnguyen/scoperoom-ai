import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { acceptInvitation, issueInvitation } from "../../../src/features/projects/server/invitations.ts";
import { createProject, listProjects } from "../../../src/features/projects/server/projects.ts";
import { requireEnv } from "../../support/env.ts";

export type Identity = { authUserId: string; displayName: string; verifiedEmail: string };
export const canRun = requireEnv(["E2E_SUPABASE_URL", "E2E_SUPABASE_SECRET_KEY", "SCOPEROOM_BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID", "NEXT_PUBLIC_APP_URL"]);

export type Fixture = {
  database: Client;
  user: (label?: string) => Promise<Identity>;
  profileId: (identity: Identity) => Promise<string>;
  entitle: (identity: Identity, maxOwnedProjects?: number) => Promise<void>;
  project: (owner: Identity, name?: string) => Promise<string>;
  /** Invites `member` with `role` and accepts through the real services. */
  join: (owner: Identity, projectId: string, member: Identity, role?: "EDITOR" | "REVIEWER" | "VIEWER") => Promise<void>;
  /** Signs the verified Auth user in with a publishable-key client. The password never leaves this fixture. */
  session: (identity: Identity) => Promise<{ accessToken: string; refreshToken: string }>;
};

export async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const authIds: string[] = [];
  const passwords = new Map<string, string>();
  await database.connect();
  const profileId = async (identity: Identity) => {
    const { rows: [row] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [identity.authUserId]);
    if (!row) throw new Error("Profile missing.");
    return row.id;
  };
  const entitle = async (identity: Identity, maxOwnedProjects = 10) => {
    await database.query(
      `insert into app.pilot_entitlement (profile_id, max_owned_projects, active, granted_by_operator) values ($1, $2, true, gen_random_uuid())
       on conflict (profile_id) do update set max_owned_projects = excluded.max_owned_projects, active = true, revoked_at = null`,
      [await profileId(identity), maxOwnedProjects],
    );
  };
  try {
    await run({
      database, profileId, entitle,
      user: async (label = "Integration Test") => {
        const verifiedEmail = `it-${randomUUID()}@example.test`;
        const password = `It-${randomUUID()}-Pass!`;
        const { data, error } = await admin.auth.admin.createUser({ email: verifiedEmail, password, email_confirm: true, user_metadata: { full_name: label } });
        if (error || !data.user) throw error ?? new Error("Could not create test user.");
        authIds.push(data.user.id);
        passwords.set(data.user.id, password);
        const identity = { authUserId: data.user.id, displayName: label, verifiedEmail };
        await listProjects(identity);
        return identity;
      },
      session: async (identity) => {
        const password = passwords.get(identity.authUserId);
        const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
        if (!password || !key) throw new Error("A publishable key and a fixture-created user are required for a real session.");
        const { data, error } = await createClient(process.env.E2E_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } }).auth.signInWithPassword({ email: identity.verifiedEmail, password });
        if (error || !data.session) throw new Error("Could not sign in the test user.");
        return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
      },
      project: async (owner, name = "Shared project") => {
        const { rows: [entitled] } = await database.query<{ count: number }>("select count(*)::int as count from app.pilot_entitlement where profile_id = $1", [await profileId(owner)]);
        if (!entitled!.count) await entitle(owner);
        return (await createProject(owner, { name, key: randomUUID() })).id;
      },
      join: async (owner, projectId, member, role = "EDITOR") => {
        const issued = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role, key: randomUUID() });
        await acceptInvitation(member, { token: issued.url!.split("/").at(-1)!, key: randomUUID() });
      },
    });
  } finally {
    if (authIds.length) {
      const profiles = "(select id from app.user_profile where auth_user_id = any($1::uuid[]))";
      await database.query(`delete from app.mutation_receipt where actor_id in ${profiles}`, [authIds]);
      await database.query(`delete from app.project where owner_id in ${profiles}`, [authIds]);
      await database.query(`delete from app.ai_budget_day where owner_id in ${profiles}`, [authIds]);
      await database.query(`delete from app.ai_owner_allowance where owner_id in ${profiles}`, [authIds]);
      await database.query(`delete from app.pilot_entitlement where profile_id in ${profiles}`, [authIds]);
      await database.query("delete from app.user_profile where auth_user_id = any($1::uuid[])", [authIds]);
      await Promise.all(authIds.map((id) => admin.auth.admin.deleteUser(id)));
    }
    await database.end();
  }
}
