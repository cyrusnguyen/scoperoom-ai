import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./collaboration-fixtures";
import { e2eReady, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.3 Task 4: the Studio header counts the other people here and names them from the members list; a selection
// is shown on the peer's step. Presence is advisory, so nothing here waits on a save.
test("a peer is counted and named from the member list, and their selection shows on the step", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const [flowId, startId] = [randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Presence", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  const toggle = ownerPage.getByRole("button", { name: /other person here/ });
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(ownerPage.locator(".participants-list")).toContainText("Collab editor");
  await editorPage.locator(`.react-flow__node[data-id="${startId}"]`).click();
  await expect(ownerPage.locator(`.react-flow__node[data-id="${startId}"]`)).toContainText("Also selected by Collab editor", { timeout: 15_000 });
});
