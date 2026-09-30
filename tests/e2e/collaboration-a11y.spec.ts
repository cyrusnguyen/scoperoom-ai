import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { interceptRealtime, test } from "./collaboration-fixtures";
import { e2eReady, seedStudioChanges } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

// Stage 04.3 Task 7: the accessibility checks for the presence controls and the live overlay. A screen reader pass (NVDA) is manual and
// is recorded separately in the evidence; nothing here stands in for it.
const nodeAt = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
const toggleOf = (page: Page) => page.getByRole("button", { name: /other (person|people) here/ });
const delayed = (page: Page) => page.getByRole("status").filter({ hasText: "Live updates delayed" });

/** `canvas: false` for the narrow layout, which opens on the step list. */
async function seedAndOpen({ ownerPage, editorPage, projectId }: { ownerPage: Page; editorPage: Page; projectId: string }, canvas = true) {
  const [flowId, startId] = [randomUUID(), randomUUID()];
  await seedStudioChanges(ownerPage, projectId, [
    { command: "CREATE_FLOW", payload: { title: "Access", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds: [flowId] },
    { command: "ADD_NODE", payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" }, proposedIds: [startId] },
  ]);
  await Promise.all([ownerPage, editorPage].map((page) => page.goto(`/app/projects/${projectId}`)));
  if (canvas) for (const page of [ownerPage, editorPage]) await expect(nodeAt(page, startId)).toBeVisible({ timeout: 20_000 });
  await expect(toggleOf(ownerPage)).toContainText("1 other person here", { timeout: 20_000 });
  return { startId };
}

test("keyboard only: the participants control is reached by Tab, shows a focus ring, opens, closes on Escape and survives a Realtime outage without taking focus", async ({ collaboration }) => {
  test.setTimeout(150_000);
  const { ownerPage: page } = collaboration;
  const wire = await interceptRealtime(page);
  await seedAndOpen(collaboration);
  const toggle = toggleOf(page);
  const list = page.locator(".participants-list");

  await page.locator("#studio-flow-title").focus();
  await page.keyboard.press("Tab"); // the next control in the toolbar
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS("outline-style", "solid"); // :focus-visible ring (globals.css), present because the focus came from the keyboard
  await expect(toggle).toHaveCSS("outline-width", "2px");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();

  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(list).toContainText("Collab editor");
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  // Recovery: a cut Realtime shows the quiet status note; it is not a dialog, does not move focus, and the control still works by keyboard.
  await wire.cut();
  await expect(delayed(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  wire.restore();
  await expect(delayed(page)).toHaveCount(0, { timeout: 40_000 });
  await expect(toggle).toBeFocused(); // the recovery did not steal it either
});

test("at 390 px the Studio header with the participants control fits, is touch-sized and the list stays on screen", async ({ collaboration }) => {
  const { ownerPage: page } = collaboration;
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAndOpen(collaboration, false);
  const toggle = toggleOf(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await fits()).toBe(true);
  for (const control of await page.locator(".studio-toolbar").getByRole("button").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x, await control.innerText()).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, await control.innerText()).toBeLessThanOrEqual(390);
  }
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const box = (await page.locator(".participants-list").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await fits()).toBe(true);
});

test("a peer's cursor and drag ghost are static under reduced motion, and they never touch a live region or become reachable", async ({ collaboration }) => {
  const { ownerPage, editorPage } = collaboration;
  const { startId } = await seedAndOpen(collaboration);
  const box = (await nodeAt(editorPage, startId).boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const pane = (await editorPage.locator(".react-flow__pane").boundingBox())!;
  const [px, py] = [pane.x + pane.width * 0.75, pane.y + pane.height * 0.4]; // on the flow view, clear of the shape panel

  // Every change inside a live region (status, alert, aria-live) on the owner's page is recorded from here on.
  await ownerPage.evaluate(() => {
    const w = window as unknown as { liveMutations: number };
    w.liveMutations = 0;
    new MutationObserver((records) => {
      for (const record of records) if ((record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[aria-live], [role="status"], [role="alert"]')) w.liveMutations++;
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const transitionMs = (locator: ReturnType<Page["locator"]>) => locator.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration) * 1000);

  await editorPage.mouse.move(px, py);
  await editorPage.mouse.move(px + 20, py + 10, { steps: 4 });
  const cursor = ownerPage.locator(".live-cursor");
  await expect(cursor).toBeVisible({ timeout: 10_000 });
  await editorPage.mouse.move(x, y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(x + 60, y + 30, { steps: 4 });
  await editorPage.mouse.move(x + 160, y + 80, { steps: 8 });
  const ghost = ownerPage.locator(`.live-ghost[data-node-id="${startId}"]`);
  await expect(ghost).toBeVisible({ timeout: 10_000 });

  // The check discriminates: with no preference the overlay does ease between packets, under reduced motion it does not.
  await ownerPage.emulateMedia({ reducedMotion: "no-preference" });
  expect(await transitionMs(ghost)).toBeGreaterThan(0);
  expect(await transitionMs(cursor)).toBeGreaterThan(0);
  await ownerPage.emulateMedia({ reducedMotion: "reduce" });
  expect(await transitionMs(ghost)).toBe(0);
  expect(await transitionMs(cursor)).toBe(0);
  expect(await ownerPage.locator(".live-overlay").evaluate((overlay) => overlay.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);

  // Hidden from assistive technology, unreachable by keyboard, and no live region was touched by any of it.
  await expect(ownerPage.locator(".live-overlay")).toHaveAttribute("aria-hidden", "true");
  await expect(ownerPage.locator(".live-overlay [tabindex], .live-overlay button, .live-overlay a, .live-overlay [aria-live], .live-overlay [role]")).toHaveCount(0);
  await editorPage.mouse.move(x + 162, y + 81);
  await editorPage.waitForTimeout(400);
  await editorPage.mouse.up();
  await expect(ghost).toHaveCount(0, { timeout: 2_000 });
  expect(await ownerPage.evaluate(() => (window as unknown as { liveMutations: number }).liveMutations)).toBe(0);
});
