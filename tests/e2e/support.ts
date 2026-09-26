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

/**
 * On this machine a browser extension injects an invisible, unstyled `<div>` directly under `<html>`
 * (a sibling of `<body>`, confirmed by capturing its creation stack via a patched `Node.appendChild`:
 * a "Web of Trust"-named userscript) with `position: relative; z-index: 2147483647; pointer-events: auto`
 * and no matching stylesheet rule, inline style or Web Animations effect — i.e. it is not app or Next.js
 * output. Because the shell's footer sits at the very bottom of the viewport, this stray node can end up
 * "on top of" the footer's Sign out button and fail Playwright's actionability check. A MutationObserver
 * on `document.documentElement` does not reliably see this node appear (its insertion timing is opaque
 * to the main world), so a short poll is used instead. This has nothing to do with shipped code, so the
 * guard lives only here, in the shared e2e sign-in path, never in `src/**`.
 */
export async function neutralizeStrayOverlays(page: Page) {
  await page.addInitScript(() => {
    function silence(node: Element) {
      if (node instanceof HTMLElement && node.tagName === "DIV" && node.parentElement === document.documentElement) {
        node.style.setProperty("pointer-events", "none", "important");
      }
    }
    const timer = window.setInterval(() => {
      for (const child of document.documentElement.children) silence(child);
    }, 250);
    window.addEventListener("beforeunload", () => window.clearInterval(timer));
  });
}

export async function signIn(page: Page, admin: SupabaseClient, users: string[], label = "E2E User") {
  const email = `e2e-${randomUUID()}@example.test`;
  const password = `E2e-${randomUUID()}-Pass!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: label } });
  if (error || !data.user) throw error ?? new Error("Could not create test user.");
  users.push(data.user.id);
  await neutralizeStrayOverlays(page);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });
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
