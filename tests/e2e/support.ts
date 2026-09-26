import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import { requireEnv } from "../support/env.ts";

export const e2eReady = requireEnv(["E2E_SUPABASE_URL", "E2E_SUPABASE_SECRET_KEY", "E2E_DATABASE_URL"]);
export const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3101";

export function adminClient() {
  return createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function openDatabase() {
  const database = new Client({ connectionString: process.env.E2E_DATABASE_URL! });
  await database.connect();
  return database;
}

export async function signIn(page: Page, admin: SupabaseClient, users: string[], label = "E2E User") {
  const email = `e2e-${randomUUID()}@example.test`;
  const password = `E2e-${randomUUID()}-Pass!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: label } });
  if (error || !data.user) throw error ?? new Error("Could not create test user.");
  users.push(data.user.id);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  expect((await page.request.get("/api/me")).status()).toBe(200);
  return { authUserId: data.user.id, email };
}

export async function entitle(database: Client, authUserId: string, maxOwnedProjects = 10) {
  await database.query(
    `insert into app.pilot_entitlement (profile_id, max_owned_projects, active, granted_by_operator)
     select id, $2, true, gen_random_uuid() from app.user_profile where auth_user_id = $1
     on conflict (profile_id) do update set max_owned_projects = excluded.max_owned_projects, active = true, revoked_at = null`,
    [authUserId, maxOwnedProjects],
  );
}

export async function createProjectViaApi(page: Page, name: string) {
  const response = await page.request.post("/api/projects", { headers: { Origin: appUrl, "Idempotency-Key": randomUUID() }, data: { name } });
  expect(response.status()).toBe(201);
  return (await response.json() as { id: string }).id;
}

export async function cleanupUsers(database: Client, admin: SupabaseClient, users: string[]) {
  if (!users.length) return;
  const profiles = "(select id from app.user_profile where auth_user_id = any($1::uuid[]))";
  await database.query(`delete from app.mutation_receipt where actor_id in ${profiles}`, [users]);
  await database.query(`delete from app.project where owner_id in ${profiles}`, [users]);
  await database.query(`delete from app.pilot_entitlement where profile_id in ${profiles}`, [users]);
  await database.query(`delete from app.user_profile where auth_user_id = any($1::uuid[])`, [users]);
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
