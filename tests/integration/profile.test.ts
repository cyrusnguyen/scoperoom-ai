import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { getDatabase } from "../../src/server/db.ts";
import { resolveProfile } from "../../src/features/access/server/profile.ts";
import { requireEnv } from "../support/env.ts";

const canRun = requireEnv(["E2E_SUPABASE_URL", "E2E_SUPABASE_SECRET_KEY", "SCOPEROOM_BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);

test("the profile name is captured at creation and never rewritten from Auth metadata", { skip: !canRun }, async () => {
  const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.createUser({ email: `profile-${randomUUID()}@example.test`, password: `Profile-${randomUUID()}-Pass!`, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create test user.");
  const cleanup = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await cleanup.connect();
  try {
    const database = await getDatabase();
    const first = await resolveProfile(database, { authUserId: data.user.id, displayName: "Original Name" });
    const second = await resolveProfile(database, { authUserId: data.user.id, displayName: "Impersonated Owner" });
    assert.equal(first.id, second.id);
    assert.equal(second.displayName, "Original Name");
  } finally {
    await cleanup.query("delete from app.user_profile where auth_user_id = $1", [data.user.id]);
    await cleanup.end();
    await admin.auth.admin.deleteUser(data.user.id);
  }
});
