import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, cleanupUsers, e2eReady, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const project = { id: "22222222-2222-4222-8222-222222222222", name: "Management project", ownerId: "55555555-5555-4555-8555-555555555555" };
const other = { id: "66666666-6666-4666-8666-666666666666", name: "Other project" };
const draft = { id: "33333333-3333-4333-8333-333333333333", schemaVersion: 3, documentRevision: 1, layoutRevision: 1, documentJson: {}, layoutJson: {} };
const empty = { items: [], truncated: false };
const owner = { profileId: project.ownerId, displayName: "Management Owner", role: "OWNER", version: 1, designatedApprover: false };
const listItem = (id: string, name: string, role: string) => ({ id, name, status: "ACTIVE", role, ownerName: "Management Owner", updatedAt: "2026-09-26T00:00:00.000Z" });
const baseStatus = {
  status: "ACTIVE", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null as string | null,
  currentDraftId: draft.id, documentRevision: 1, layoutRevision: 1, realtimeEpoch: "77777777-7777-4777-8777-777777777777", eventSequence: 1,
};

async function mockOwnerLists(page: Page) {
  await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [listItem(project.id, project.name, "OWNER"), listItem(other.id, other.name, "OWNER")], truncated: false }, shared: empty, archived: empty, capacity: { entitled: true, activeOwned: 2, maxOwned: 10, canCreate: true } } }));
  await page.route("**/api/invitations", (route) => route.fulfill({ json: empty }));
  await page.route(`**/api/projects/${project.id}/invitations`, (route) => route.fulfill({ json: { invitations: [] } }));
  await page.route(`**/api/projects/${other.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...other, status: "ACTIVE", role: "OWNER", ownerId: project.ownerId }, draft } }));
}

// A beforeunload listener that calls preventDefault() is what makes the browser ask before leaving.
const warnsBeforeUnload = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

test.describe("project details", () => {
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

  test("an owner changes a member role, chooses an approver, archives, then reduces and removes access", async ({ page }) => {
    let status = { ...baseStatus };
    const member = { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Casey Collaborator", role: "VIEWER", version: 1 };
    let removed = false;
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...project, status: status.status, role: "OWNER" }, draft } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [owner, ...(removed ? [] : [{ ...member, designatedApprover: status.designatedApproverId === member.profileId }])] } }));
    await page.route(`**/api/projects/${project.id}/members/${member.profileId}`, async (route) => {
      const body = route.request().postDataJSON() as { role?: string; expectedMemberVersion: number };
      expect(body.expectedMemberVersion).toBe(member.version);
      expect(route.request().headers()["idempotency-key"]).toHaveLength(36);
      member.version += 1;
      if (route.request().method() === "DELETE") {
        removed = true;
        status = { ...status, membershipVersion: status.membershipVersion + 1, designatedApproverId: null, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
        return route.fulfill({ json: { ...status, profileId: member.profileId, memberVersion: member.version, replayed: false } });
      }
      member.role = body.role!;
      status = { ...status, membershipVersion: status.membershipVersion + 1 };
      await route.fulfill({ json: { ...status, profileId: member.profileId, role: member.role, memberVersion: member.version, replayed: false } });
    });
    await page.route(`**/api/projects/${project.id}/approval-policy`, async (route) => {
      const body = route.request().postDataJSON() as { designatedApproverId: string; expectedApprovalPolicyVersion: number };
      expect(body.expectedApprovalPolicyVersion).toBe(status.approvalPolicyVersion);
      status = { ...status, designatedApproverId: body.designatedApproverId, approvalPolicyVersion: status.approvalPolicyVersion + 1 };
      await route.fulfill({ json: { ...status, replayed: false } });
    });
    await page.route(`**/api/projects/${project.id}/archive`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedProjectVersion: status.version, reason: "Finished pilot work" });
      status = { ...status, status: "ARCHIVED", version: status.version + 1 };
      await route.fulfill({ json: { ...status, replayed: false } });
    });

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Inspect" }).click();
    const panel = page.locator("#right-panel");
    await expect(panel.getByText("Casey Collaborator", { exact: true })).toBeVisible();
    await expect(panel.getByText("2 of 10")).toBeVisible();
    await panel.getByLabel("Role for Casey Collaborator").selectOption("EDITOR");
    await expect(panel.getByText("Member role updated.")).toBeVisible();
    await panel.getByLabel("Designated approver").selectOption(member.profileId);
    await panel.getByRole("button", { name: "Save approver" }).click();
    await expect(panel.getByText("Approver updated.")).toBeVisible();
    await expect(panel.getByText("Editor · Designated approver")).toBeVisible();

    await panel.getByRole("button", { name: "Archive project…" }).click();
    const dialog = page.getByRole("dialog", { name: `Archive ${project.name}?` });
    await dialog.getByLabel("Reason").fill("Finished pilot work");
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Archived · read-only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore…" })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Save approver" })).toHaveCount(0);

    await panel.getByLabel("Role for Casey Collaborator").selectOption("REVIEWER");
    await expect(panel.getByText("Changing Casey Collaborator to Reviewer reduces their project access.")).toBeVisible();
    await panel.getByRole("button", { name: "Confirm role change" }).click();
    await expect(panel.getByLabel("Role for Casey Collaborator").locator("option[value=EDITOR]")).toHaveCount(0);
    await panel.getByRole("button", { name: "Remove Casey Collaborator" }).click();
    await expect(panel.getByText(/Removing Casey Collaborator revokes their project access\. They are the designated approver/)).toBeVisible();
    await panel.getByRole("button", { name: "Confirm removal" }).click();
    await expect(panel.getByText("Casey Collaborator", { exact: true })).toHaveCount(0);
  });

  test("a non-owner reads the project and its members, with Leave instead of management controls", async ({ page }) => {
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: empty, shared: { items: [listItem(project.id, project.name, "VIEWER")], truncated: false }, archived: empty, capacity: { entitled: false, activeOwned: 0, maxOwned: 0, canCreate: false } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: empty }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...project, status: "ACTIVE", role: "VIEWER" }, draft } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: baseStatus }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: baseStatus, members: [owner, { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Management Test", role: "VIEWER", version: 1, designatedApprover: false }] } }));

    await page.goto(`/app/projects/${project.id}`);
    await expect(page.locator("#editor-main").getByText("Viewer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Inspect" }).click();
    const panel = page.locator("#right-panel");
    await expect(panel.getByText("Management Owner", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText(project.name, { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Project name")).toHaveCount(0);
    await expect(panel.getByLabel("Role for Management Test")).toHaveCount(0);
    await expect(panel.getByLabel("Verified email")).toHaveCount(0);
    await expect(panel.getByLabel("Designated approver")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Archive project…" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Leave project…" })).toBeVisible();
  });

  test("unsaved Details edits survive panel close, tab changes and history, and a sidebar switch asks first", async ({ page }) => {
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { project: { ...project, status: "ACTIVE", role: "OWNER" }, draft } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: baseStatus }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: baseStatus, members: [owner] } }));
    const nav = page.locator("#projects-nav");
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");

    await page.goto(`/app/projects/${other.id}`);
    await nav.getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await nameField.fill("Renamed project");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await panel.getByRole("button", { name: "Close panel" }).click();
    await nav.getByRole("tab", { name: "Shared with me" }).click();
    await nav.getByRole("tab", { name: "Owned projects" }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(nameField).toHaveValue("Renamed project");

    // History navigation bypasses the sidebar guard, so the value must survive it instead.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: other.name })).toBeVisible();
    await page.goForward();
    await expect(nameField).toHaveValue("Renamed project");

    await nav.getByRole("button", { name: other.name, exact: true }).click();
    const guard = page.getByRole("dialog", { name: `Unsaved changes in ${project.name}` });
    await expect(guard.getByText("1 unsaved field(s).")).toBeVisible();
    await expect(guard.getByRole("button", { name: "Stay" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(guard).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
    await expect(nameField).toHaveValue("Renamed project");

    await nav.getByRole("button", { name: other.name, exact: true }).click();
    await guard.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${other.id}$`));
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.goBack();
    await expect(nameField).toHaveValue(project.name);
  });
});
