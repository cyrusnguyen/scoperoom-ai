import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { emptyDraft, parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, cleanupUsers, e2eReady, MOCK_VIEWER_ID, openDatabase, signIn, withStatus } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const project = { id: "22222222-2222-4222-8222-222222222222", name: "Management project", ownerId: "55555555-5555-4555-8555-555555555555" };
const other = { id: "66666666-6666-4666-8666-666666666666", name: "Other project" };
const storedEmptyDraft = emptyDraft();
const flowId = "11111111-1111-4111-8111-111111111111";
const draft = {
  id: "33333333-3333-4333-8333-333333333333", status: "EDITABLE" as const, documentRevision: 1, layoutRevision: 1,
  ...parseDraftPair({
    ...storedEmptyDraft.document,
    flows: {
      [flowId]: {
        id: flowId, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "",
        classification: "BUSINESS_PROCESS", inclusion: "INCLUDED", confirmation: null, verificationMethod: null,
      },
    },
  }, { ...storedEmptyDraft.layout, directions: { [flowId]: "TB" } }),
};
const empty = { items: [], truncated: false };
const owner = { profileId: project.ownerId, displayName: "Management Owner", role: "OWNER", version: 1, designatedApprover: false };
const listItem = (id: string, name: string, role: string) => ({ id, name, status: "ACTIVE", role, ownerName: "Management Owner", updatedAt: "2026-09-26T00:00:00.000Z" });
const baseStatus = {
  viewerId: MOCK_VIEWER_ID, status: "ACTIVE", role: "OWNER", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null as string | null,
  currentDraftId: draft.id, documentRevision: 1, layoutRevision: 1, realtimeEpoch: "77777777-7777-4777-8777-777777777777", eventSequence: 1, aiRevision: 0, sourcesRevision: 0, reviewsRevision: 0, baselineSequence: 0, approvedSnapshotId: null,
};

async function mockOwnerLists(page: Page) {
  await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: { items: [listItem(project.id, project.name, "OWNER"), listItem(other.id, other.name, "OWNER")], truncated: false }, shared: empty, archived: empty, capacity: { entitled: true, activeOwned: 2, maxOwned: 10, canCreate: true } } }));
  await page.route("**/api/invitations", (route) => route.fulfill({ json: empty }));
  await page.route(`**/api/projects/${project.id}/invitations`, (route) => route.fulfill({ json: { invitations: [] } }));
  await page.route(`**/api/projects/${other.id}/bootstrap`, (route) => route.fulfill({ json: withStatus({ project: { ...other, status: "ACTIVE", role: "OWNER", ownerId: project.ownerId }, draft }) }));
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

  test.afterEach(async ({ page }) => {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  });

  test("an owner changes a member role, chooses an approver, archives, then reduces and removes access", async ({ page }) => {
    let status = { ...baseStatus };
    const member = { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Casey Collaborator", role: "VIEWER", version: 1 };
    let removed = false;
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { ...withStatus({ project: { ...project, status: status.status, role: "OWNER" }, draft }), status } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [{ ...owner, designatedApprover: status.designatedApproverId === owner.profileId }, ...(removed ? [] : [{ ...member, designatedApprover: status.designatedApproverId === member.profileId }])] } }));
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
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
    await expect(panel.getByText("1 flow · revision 1")).toBeVisible();
    await expect(panel.getByText("Casey Collaborator", { exact: true })).toBeVisible();
    await expect(panel.getByText("2 of 10")).toBeVisible();
    await panel.getByLabel("Designated approver").selectOption(owner.profileId);
    await panel.getByRole("button", { name: "Save approver" }).click();
    await expect(panel.getByText("Owner · Designated approver", { exact: true })).toBeVisible();
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
    // "Archive project…" is gone, so focus lands on the editor heading rather than <body>.
    await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeFocused();
    await expect(page.getByRole("button", { name: "Restore…" })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Save approver" })).toHaveCount(0);
    const archivedNote = panel.getByText("Settings and role increases are unavailable; the owner can reduce or remove member access.");
    await expect(archivedNote).toBeVisible();
    await expect(archivedNote).not.toHaveRole("alert");
    expect(await archivedNote.evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");

    // A reduction names its effect first; initial focus is the safe Cancel, and both buttons are described by the note.
    const roleSelect = panel.getByLabel("Role for Casey Collaborator");
    const changeText = "Changing Casey Collaborator to Reviewer reduces their project access.";
    const noteCancel = panel.getByRole("group", { name: "Confirm access change" }).getByRole("button", { name: "Cancel" });
    const confirmChange = panel.getByRole("button", { name: "Confirm role change" });
    await roleSelect.selectOption("REVIEWER");
    await expect(panel.getByText(changeText)).toBeVisible();
    await expect(noteCancel).toBeFocused();
    await expect(noteCancel).toHaveAccessibleDescription(changeText);
    await expect(confirmChange).toHaveAccessibleDescription(changeText);
    expect(await panel.locator(".inline-note").evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");
    await page.keyboard.press("Enter"); // Enter on the initial focus cancels
    await expect(confirmChange).toHaveCount(0);
    await expect(roleSelect).toBeFocused();
    await expect(roleSelect).toHaveValue("EDITOR");
    await roleSelect.selectOption("REVIEWER");
    await confirmChange.click();
    await expect(roleSelect.locator("option[value=EDITOR]")).toHaveCount(0);
    await expect(roleSelect).toBeFocused();

    const removeButton = panel.getByRole("button", { name: "Remove Casey Collaborator" });
    const removeText = /^Removing Casey Collaborator revokes their project access\. They are the designated approver/;
    const confirmRemoval = panel.getByRole("button", { name: "Confirm removal" });
    await removeButton.click();
    await expect(panel.getByText(removeText)).toBeVisible();
    await expect(noteCancel).toBeFocused();
    await expect(noteCancel).toHaveAccessibleDescription(removeText);
    await expect(confirmRemoval).toHaveAccessibleDescription(removeText);
    await noteCancel.click();
    await expect(removeButton).toBeFocused();
    await removeButton.click();
    await confirmRemoval.click();
    await expect(panel.getByText("Casey Collaborator", { exact: true })).toHaveCount(0);
    await expect(panel.locator("#details-members")).toBeFocused();
  });

  test("a non-owner reads the project and its members, with Leave instead of management controls", async ({ page }) => {
    await page.route("**/api/projects", (route) => route.fulfill({ json: { owned: empty, shared: { items: [listItem(project.id, project.name, "VIEWER")], truncated: false }, archived: empty, capacity: { entitled: false, activeOwned: 0, maxOwned: 0, canCreate: false } } }));
    await page.route("**/api/invitations", (route) => route.fulfill({ json: empty }));
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: withStatus({ project: { ...project, status: "ACTIVE", role: "VIEWER" }, draft }) }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: baseStatus }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: baseStatus, members: [owner, { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Management Test", role: "VIEWER", version: 1, designatedApprover: false }] } }));

    await page.goto(`/app/projects/${project.id}`);
    await expect(page.locator("#editor-main").getByText("Viewer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Inspect" }).click();
    const panel = page.locator("#right-panel");
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
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
    let status = { ...baseStatus };
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { ...withStatus({ project: { ...project, status: "ACTIVE", role: "OWNER" }, draft }), status } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [owner] } }));
    await page.route(`**/api/projects/${project.id}/settings`, async (route) => {
      status = { ...status, settingsVersion: status.settingsVersion + 1 };
      await route.fulfill({ json: { ...status, replayed: false } });
    });
    const nav = page.locator("#projects-nav");
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");

    await page.goto(`/app/projects/${other.id}`);
    await nav.getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
    expect(await warnsBeforeUnload(page)).toBe(false);
    await nameField.fill("Renamed once");
    expect(await warnsBeforeUnload(page)).toBe(true);
    // A successful save clears the draft: the leave-page warning stops (Review Focus 2).
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("Project name updated.")).toBeVisible();
    expect(await warnsBeforeUnload(page)).toBe(false);

    await nameField.fill("Renamed project");
    expect(await warnsBeforeUnload(page)).toBe(true);
    await panel.getByRole("button", { name: "Close panel" }).click();
    await nav.getByRole("tab", { name: "Shared with me" }).click();
    await nav.getByRole("tab", { name: "Owned projects" }).click();
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
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
    await expect(nav.getByRole("button", { name: other.name, exact: true })).toBeFocused(); // closing returns focus to the opener
    await expect(page).toHaveURL(new RegExp(`/app/projects/${project.id}$`));
    await expect(nameField).toHaveValue("Renamed project");

    await nav.getByRole("button", { name: other.name, exact: true }).click();
    await guard.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${other.id}$`));
    expect(await warnsBeforeUnload(page)).toBe(false);
    await page.goBack();
    await expect(nameField).toHaveValue(project.name);
  });

  test("an uncertain Details save locks the forms until Retry or Discard, and a conflict re-reads the saved name", async ({ page }) => {
    let status = { ...baseStatus };
    let savedName = project.name;
    const keys: string[] = [];
    const member = { profileId: "44444444-4444-4444-8444-444444444444", displayName: "Casey Collaborator", role: "EDITOR", version: 1, designatedApprover: false };
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { ...withStatus({ project: { ...project, name: savedName, status: "ACTIVE", role: "OWNER" }, draft }), status } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [owner, member] } }));
    await page.route(`**/api/projects/${project.id}/settings`, async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (keys.length <= 2) return route.abort("failed");
      // Another tab renamed the project in the meantime.
      savedName = "Renamed elsewhere";
      status = { ...status, settingsVersion: status.settingsVersion + 1 };
      await route.fulfill({ status: 409, json: { error: { code: "CONFLICT", message: "That change conflicts with current data. Refresh and try again.", requestId: "00000000-0000-4000-8000-000000000000", retryable: false } } });
    });
    const panel = page.locator("#right-panel");
    const nameField = panel.getByLabel("Project name");

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
    await nameField.fill("First attempt");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("We could not confirm that change. Retry uses the same request.");
    // Only Retry change or Discard change remain, so retrying the old body can't silently drop a newer edit.
    await expect(nameField).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Designated approver")).toBeDisabled();
    // A member change would clear the pending retry's key, so member controls wait too.
    await expect(panel.getByLabel("Role for Casey Collaborator")).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Remove Casey Collaborator" })).toBeDisabled();
    const retryChange = panel.getByRole("button", { name: "Retry change" });
    await expect(retryChange).toBeEnabled();
    // Retry reuses the key; still uncertain, so focus comes back to Retry change rather than <body>.
    await retryChange.click();
    await expect(retryChange).toBeFocused();
    expect(keys[1]).toBe(keys[0]);
    await panel.getByRole("button", { name: "Discard change" }).click();
    await expect(nameField).toBeEnabled();
    await expect(nameField).toBeFocused();
    await expect(nameField).toHaveValue(project.name);
    await expect(panel.getByLabel("Role for Casey Collaborator")).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Retry change" })).toHaveCount(0);

    await nameField.fill("Second attempt");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("That change conflicts with current data. Refresh and try again.");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Renamed elsewhere");
    await expect(nameField).toHaveValue("Second attempt");
    expect(keys).toHaveLength(3);
  });

  test("a settling Details save never pulls focus from a field the user moved to meanwhile", async ({ page }) => {
    let status = { ...baseStatus };
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { ...withStatus({ project: { ...project, status: "ACTIVE", role: "OWNER" }, draft }), status } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [owner] } }));
    await page.route(`**/api/projects/${project.id}/settings`, async (route) => {
      await held;
      status = { ...status, settingsVersion: status.settingsVersion + 1 };
      await route.fulfill({ json: { ...status, replayed: false } });
    });
    const panel = page.locator("#right-panel");
    const email = panel.getByLabel("Verified email");

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
    await panel.getByLabel("Project name").fill("Renamed while typing");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await email.click();
    await page.keyboard.type("casey@exa");
    release();
    await expect(panel.getByText("Project name updated.")).toBeVisible();
    await expect(email).toBeFocused();
    await page.keyboard.type("mple.test");
    await expect(email).toHaveValue("casey@example.test");
  });

  test("an unsaved edit does not linger as dirty after the project is archived", async ({ page }) => {
    let status = { ...baseStatus };
    await mockOwnerLists(page);
    await page.route(`**/api/projects/${project.id}/bootstrap`, (route) => route.fulfill({ json: { ...withStatus({ project: { ...project, status: status.status, role: "OWNER" }, draft }), status } }));
    await page.route(`**/api/projects/${project.id}/status`, (route) => route.fulfill({ json: status }));
    await page.route(`**/api/projects/${project.id}/members`, (route) => route.fulfill({ json: { project: status, members: [owner] } }));
    await page.route(`**/api/projects/${project.id}/archive`, async (route) => {
      status = { ...status, status: "ARCHIVED", version: status.version + 1 };
      await route.fulfill({ json: { ...status, replayed: false } });
    });
    const nav = page.locator("#projects-nav");
    const panel = page.locator("#right-panel");

    await page.goto(`/app/projects/${project.id}`);
    await page.getByRole("button", { name: "Inspect" }).click();
    await panel.getByRole("button", { name: "Back to project", exact: true }).click();
    await panel.getByLabel("Project name").fill("Renamed before archive");
    expect(await warnsBeforeUnload(page)).toBe(true);

    await panel.getByRole("button", { name: "Archive project…" }).click();
    const archiveDialog = page.getByRole("dialog", { name: `Archive ${project.name}?` });
    await archiveDialog.getByLabel("Reason").fill("Finished pilot work");
    await archiveDialog.getByRole("button", { name: "Archive" }).click();
    await expect(archiveDialog).toHaveCount(0);
    await expect(page.getByText("Archived · read-only")).toBeVisible();

    // The renamed field is now hidden (archived projects are read-only), so its draft must not stay dirty.
    await nav.getByRole("button", { name: other.name, exact: true }).click();
    await expect(page.getByRole("dialog", { name: `Unsaved changes in ${project.name}` })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${other.id}$`));
    expect(await warnsBeforeUnload(page)).toBe(false);
  });
});
