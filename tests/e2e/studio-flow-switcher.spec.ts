import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, e2eReady, entitle, openDatabase, signIn } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

test("closing the switcher when its last flow disappears does not reopen it after the next flow is created", async ({ page }) => {
  test.setTimeout(90_000);
  const admin: SupabaseClient = adminClient();
  const database: Client = await openDatabase();
  const users: string[] = [];
  try {
    const { authUserId } = await signIn(page, admin, users, "Flow switcher owner");
    await entitle(database, authUserId);
    const projectId = await createProjectViaApi(page, "Flow switcher project");
    await page.goto(`/app/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Flow switcher project" })).toBeVisible();

    await page.getByRole("button", { name: "New flow" }).click();
    const create = dialog(page, "New flow");
    await create.getByLabel("Title").fill("Original");
    await create.getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator(".flow-switch")).toContainText("Original");
    await page.locator(".flow-switch").click();
    const flows = dialog(page, "Flows");

    const draft = await draftOf(page, projectId);
    const flow = Object.values(draft.document.flows)[0]!;
    await page.request.post(`/api/projects/${projectId}/drafts/${draft.id}/commands`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { flowId: flow.id, removeNodeIds: [], removeEdgeIds: [] } },
    }).then((response) => expect(response.status()).toBe(200));

    // The open duplicate becomes stale, causing the Studio to reread the now-empty draft.
    await flows.getByRole("button", { name: "Duplicate Original" }).click();
    await expect(flows).toBeHidden();
    await expect(page.getByRole("heading", { name: "No flows yet" })).toBeVisible();

    await page.getByRole("button", { name: "New flow" }).click();
    const next = dialog(page, "New flow");
    await next.getByLabel("Title").fill("Next");
    await next.getByRole("button", { name: "Create flow" }).click();
    await expect(page.locator("#studio-flow-title")).toHaveText("Next");
    await expect(dialog(page, "Flows")).toBeHidden();
  } finally {
    try { await cleanupUsers(database, admin, users, page); } finally { await database.end(); }
  }
});
