import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { adminClient, cleanupUsers, e2eReady, openDatabase, signIn } from "./support";

const project = { id: "22222222-2222-4222-8222-222222222222", name: "Management project", status: "ACTIVE", ownerId: "55555555-5555-4555-8555-555555555555" };
const draft = { id: "33333333-3333-4333-8333-333333333333", schemaVersion: 3, documentRevision: 1, layoutRevision: 1 };
const empty = { items: [], truncated: false };
const listItem = { id: project.id, name: project.name, status: "ACTIVE", ownerName: "Management Owner" };

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test.describe("project management", () => {
  let admin: SupabaseClient;
  let database: Client;
  let users: string[];

  test.beforeEach(async ({ page }) => {
    admin = adminClient();
    database = await openDatabase();
    users = [];
    await signIn(page, admin, users, "Management Test");
  });

  test.afterEach(async () => {
    try { await cleanupUsers(database, admin, users); } finally { await database.end(); }
  });

  test("an owner changes a member role, chooses an approver, and archives the project", async ({ page }) => {
    let status = { status: "ACTIVE", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null as string | null };
    const member = { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Casey Collaborator", role: "VIEWER", version: 1, designatedApprover: false };
    let removed = false;
    const response = () => ({ project: status, members: removed ? [] : [member] });
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [{ ...listItem, role: "OWNER" }], truncated: false }, shared: empty, archived: empty, capacity: { entitled: true, activeOwned: 1, maxOwned: 10, canCreate: true } } }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { ...project, role: "OWNER" }, draft }) }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
    await page.route(`**/api/projects/${project.id}/members/${member.profileId}`, async (route) => {
      if (route.request().method() === "DELETE") {
        const body = route.request().postDataJSON() as { expectedMemberVersion: number };
        expect(body.expectedMemberVersion).toBe(member.version);
        removed = true;
        member.version += 1;
        status = { ...status, membershipVersion: status.membershipVersion + 1, designatedApproverId: null, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, profileId: member.profileId, memberVersion: member.version, replayed: false }) });
      }
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON() as { role: string; expectedMemberVersion: number };
      expect(body.expectedMemberVersion).toBe(member.version);
      expect(route.request().headers()["idempotency-key"]).toHaveLength(36);
      member.role = body.role;
      member.version += 1;
      status = { ...status, membershipVersion: status.membershipVersion + 1 };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, profileId: member.profileId, role: member.role, memberVersion: member.version, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(response()) }));
    await page.route(`**/api/projects/${project.id}/approval-policy`, async (route) => {
      const body = route.request().postDataJSON() as { designatedApproverId: string; expectedApprovalPolicyVersion: number };
      expect(body.expectedApprovalPolicyVersion).toBe(status.approvalPolicyVersion);
      status = { ...status, designatedApproverId: body.designatedApproverId, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, replayed: false }) });
    });
    await page.route(`**/api/projects/${project.id}/archive`, async (route) => {
      const body = route.request().postDataJSON() as { expectedProjectVersion: number; reason: string };
      expect(body.expectedProjectVersion).toBe(status.version);
      expect(body.reason).toBe("Finished pilot work");
      status = { ...status, status: "ARCHIVED", version: status.version + 1 };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...status, replayed: false }) });
    });

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Manage project" }).click();
    await expect(page.getByText("Casey Collaborator", { exact: true })).toBeVisible();
    await page.getByLabel("Role for Casey Collaborator").selectOption("EDITOR");
    await expect(page.getByRole("region", { name: "Project management" }).getByRole("status")).toContainText("Member role updated.");
    await page.getByLabel("Designated approver").selectOption(member.profileId);
    await page.getByRole("button", { name: "Save approver" }).click();
    await expect(page.getByRole("region", { name: "Project management" }).getByRole("status")).toContainText("Approver updated.");
    await page.getByRole("button", { name: "Archive project" }).click();
    await page.getByLabel("Archive reason").fill("Finished pilot work");
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore project" })).toBeVisible();
    await page.getByLabel("Role for Casey Collaborator").selectOption("REVIEWER");
    await expect(page.getByRole("button", { name: "Confirm role change" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm role change" }).click();
    await expect(page.getByLabel("Role for Casey Collaborator").locator("option[value=EDITOR]")).toHaveCount(0);
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect(page.getByText("Casey Collaborator", { exact: true })).toHaveCount(0);
  });

  test("a non-owner can inspect members without management controls", async ({ page }) => {
    const status = { status: "ACTIVE", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null };
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: empty, shared: { items: [{ ...listItem, role: "VIEWER" }], truncated: false }, archived: empty, capacity: { entitled: false, activeOwned: 0, maxOwned: 0, canCreate: false } } }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { ...project, role: "VIEWER" }, draft }) }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: status, members: [{ profileId: "44444444-4444-4444-8444-444444444444", displayName: "Owner", role: "OWNER", version: 1, designatedApprover: false }] }) }));

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Manage project" }).click();
    await expect(page.getByRole("region", { name: "Project management" }).getByText("Owner", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Project name")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Archive project" })).toHaveCount(0);
  });
});
