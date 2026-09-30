import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./collaboration-fixtures";
import { e2eReady, saveStudio, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const ghostAt = (page: Page, nodeId: string) => page.locator(`.live-ghost[data-node-id="${nodeId}"]`);
const transformOf = (page: Page, nodeId: string) => nodeAt(page, nodeId).evaluate((element) => (element as HTMLElement).style.transform);

// Stage 04.3 Task 5: a peer's drag is an advisory, labelled outline in flow space; it never moves a canonical node, and the
// only saved result is the peer's own Save.
test("a peer's drag shows as a labelled ghost at any pan and zoom, the canonical step stays put until the save, and the ghost ends with the drag", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const [flowId, startId, nextId] = [randomUUID(), randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Live", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
    { command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Next", description: "", actorLabel: "" }, proposedIds: [nextId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  await expect(nodeAt(ownerPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 }); // both are subscribed and in the roster
  // The owner views the flow at a different zoom than the editor drags at.
  await ownerPage.getByRole("button", { name: "Zoom Out" }).click();
  await ownerPage.waitForTimeout(400);
  const savedTransform = await transformOf(ownerPage, startId);

  const box = (await nodeAt(editorPage, startId).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await editorPage.mouse.move(x, y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(x + 60, y + 30, { steps: 4 });
  await editorPage.mouse.move(x + 160, y + 80, { steps: 8 });

  const ghost = ghostAt(ownerPage, startId);
  await expect(ghost).toBeVisible({ timeout: 10_000 });
  await expect(ghost).toContainText("Collab editor");
  await expect(ownerPage.locator(".live-overlay")).toHaveAttribute("aria-hidden", "true");
  await expect(ownerPage.locator("[aria-live] .live-overlay, .live-overlay [aria-live]")).toHaveCount(0);
  // The ghost is a pointer-events-none outline; the canonical step has not moved (only a save moves it).
  await expect(ghost).toHaveCSS("pointer-events", "none");
  expect(await transformOf(ownerPage, startId)).toBe(savedTransform);
  const [ghostBox, nodeBox] = [(await ghost.boundingBox())!, (await nodeAt(ownerPage, startId).boundingBox())!];
  expect(Math.abs(ghostBox.x - nodeBox.x) + Math.abs(ghostBox.y - nodeBox.y)).toBeGreaterThan(10);
  // The ghost is drawn in flow space under the owner's zoom: it is as wide as the owner's own (zoomed-out) copy of the step.
  expect(Math.abs(ghostBox.width - nodeBox.width)).toBeLessThan(4);
  expect(nodeBox.width).toBeLessThan(box.width); // the owner really is zoomed out relative to the editor

  // A fresh update right before the drop, so only DRAG_END (not the 2 s expiry) can remove the ghost within the next second.
  await editorPage.mouse.move(x + 162, y + 81);
  await expect(ghost).toBeVisible();
  await editorPage.mouse.up();
  await expect(ghost).toHaveCount(0, { timeout: 1_000 });
  expect(await transformOf(ownerPage, startId)).toBe(savedTransform); // unsaved: nothing changed for the owner

  await saveStudio(editorPage);
  await ownerPage.reload();
  await expect(nodeAt(ownerPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => transformOf(ownerPage, startId)).not.toBe(savedTransform);
  const placed = await transformOf(ownerPage, startId);
  await editorPage.reload();
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => transformOf(editorPage, startId)).toBe(placed);
});

test("a peer's cursor over the canvas is labelled; over a panel it is not published", async ({ collaboration: { ownerPage, editorPage, projectId } }) => {
  const [flowId, startId] = [randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Cursors", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  await expect(nodeAt(editorPage, startId)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /other person here/ })).toBeVisible({ timeout: 20_000 });
  const pane = (await editorPage.locator(".react-flow__pane").boundingBox())!;
  await editorPage.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 40);
  await editorPage.mouse.move(pane.x + pane.width / 2 + 20, pane.y + pane.height - 30, { steps: 4 });
  const cursor = ownerPage.locator(".live-cursor");
  await expect(cursor).toBeVisible({ timeout: 10_000 });
  await expect(cursor).toContainText("Collab editor");
  await expect(cursor).toHaveCSS("pointer-events", "none");
  // Nothing is published from the controls: keep moving over them longer than the 2 s preview TTL. A published position would
  // keep the cursor alive there; instead the last one from the canvas expires.
  const controls = (await editorPage.locator(".canvas-controls").boundingBox())!;
  const [cx, cy] = [controls.x + controls.width / 2, controls.y + controls.height / 2];
  await editorPage.mouse.move(cx, cy, { steps: 6 });
  for (let step = 0; step < 14; step++) { await editorPage.mouse.move(cx + (step % 2 ? 4 : -4), cy); await editorPage.waitForTimeout(200); }
  await expect(cursor).toHaveCount(0, { timeout: 500 });
});
