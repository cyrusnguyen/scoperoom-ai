import { expect, type Page } from "@playwright/test";
import { test } from "./studio-fixtures";
import type { DraftView } from "../../src/features/drafts/contracts/scope-document.ts";
import { createProjectViaApi, e2eReady, saveStudio } from "./support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

const toolbar = (page: Page) => page.locator(".studio-toolbar");
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });

async function draftOf(page: Page, projectId: string): Promise<DraftView> {
  return (await (await page.request.get(`/api/projects/${projectId}/bootstrap`)).json() as { draft: DraftView }).draft;
}

async function createFlow(page: Page) {
  await page.getByRole("button", { name: "New flow" }).click();
  const form = dialog(page, "New flow");
  await form.getByLabel("Title").fill("Visibility check");
  await form.getByRole("button", { name: "Create flow" }).click();
  await expect(page.locator("#studio-flow-title")).toHaveText("Visibility check");
}

async function addStep(page: Page, label: string, shape: "Start" | "Outcome") {
  await toolbar(page).getByRole("button", { name: "Add step" }).click();
  const form = dialog(page, "Add step");
  await form.getByLabel("Shape").selectOption({ label: shape });
  await form.getByLabel("Name").fill(label);
  await form.getByRole("button", { name: "Add step" }).click();
  await expect(form).toBeHidden();
}

test.describe("Studio canvas visibility", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    projectId = await createProjectViaApi(page, "Canvas visibility project");
    await page.goto(`/app/projects/${projectId}`);
  });

  test("keeps measured steps and their connection visible through selection and a save", async ({ page }) => {
    await createFlow(page);
    await addStep(page, "Cart", "Start");
    await addStep(page, "Done", "Outcome");
    await toolbar(page).getByRole("button", { name: "Connect" }).click();
    const connect = dialog(page, "Connect steps");
    await connect.getByLabel("From").selectOption({ label: "Cart" });
    await connect.getByLabel("To").selectOption({ label: "Done" });
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect).toBeHidden();
    await saveStudio(page);

    const draft = await draftOf(page, projectId);
    const [cartId, doneId] = Object.keys(draft.document.nodes);
    const edgeId = Object.keys(draft.document.edges)[0];
    const nodes = page.locator(".react-flow__node");
    await expect(nodes).toHaveCount(2);
    await expect.poll(async () => page.evaluate((ids) => ids.every((id) => {
      const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      const rect = node?.getBoundingClientRect();
      return !!node && rect!.width > 0 && rect!.height > 0 && getComputedStyle(node).visibility === "visible";
    }), [cartId, doneId])).toBe(true);
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`)).toHaveAttribute("d", /.+/);

    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    const cartCheck = page.getByRole("checkbox", { name: "Select Cart" });
    await cartCheck.check();
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    const cartNode = page.locator(`.react-flow__node[data-id="${cartId}"]`);
    await expect(cartNode).toHaveClass(/selected/);
    await toolbar(page).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await toolbar(page).getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(cartNode).not.toHaveClass(/selected/);
    await page.evaluate((ids) => {
      type Sample = { id: string; width: number; height: number; visibility: string; display: string } | null;
      const capture = () => ids.map((id): Sample => {
        const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { id, width: rect.width, height: rect.height, visibility: style.visibility, display: style.display };
      });
      const target = window as Window & { __canvasSamples?: Sample[][]; __canvasSampling?: boolean };
      target.__canvasSamples = [];
      target.__canvasSampling = true;
      const sample = () => {
        target.__canvasSamples!.push(capture());
        if (target.__canvasSampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, [cartId, doneId]);
    const beforeSelection = await page.evaluate(() => (window as Window & { __canvasSamples?: unknown[] }).__canvasSamples?.length ?? 0);
    await cartNode.click();
    await expect(cartNode).toHaveClass(/selected/);
    await page.waitForTimeout(100);
    const afterSelection = await page.evaluate(() => (window as Window & { __canvasSamples?: unknown[] }).__canvasSamples?.length ?? 0);
    expect(afterSelection - beforeSelection).toBeGreaterThan(0);
    await toolbar(page).getByRole("button", { name: "Add step" }).click();
    const add = dialog(page, "Add step");
    await add.getByLabel("Name").fill("Saved after selection");
    await add.getByRole("button", { name: "Add step" }).click();
    await expect(add).toBeHidden();
    await expect(nodes).toHaveCount(3);
    await page.waitForTimeout(150);

    const samples = await page.evaluate(() => {
      const target = window as Window & { __canvasSamples?: ({ id: string; width: number; height: number; visibility: string; display: string } | null)[][]; __canvasSampling?: boolean };
      target.__canvasSampling = false;
      return target.__canvasSamples ?? [];
    });
    expect(samples.length - afterSelection).toBeGreaterThan(0);
    const assertVisible = (frames: typeof samples) => {
      for (const frame of frames) {
        for (const sample of frame) {
          expect(sample, "a measured step stays mounted").not.toBeNull();
          expect(sample!.width, "a step keeps its measured width").toBeGreaterThan(0);
          expect(sample!.height, "a step keeps its measured height").toBeGreaterThan(0);
          expect(sample!.visibility, "a step stays visible").toBe("visible");
          expect(sample!.display, "a step stays displayed").not.toBe("none");
        }
      }
    };
    assertVisible(samples.slice(beforeSelection, afterSelection));
    assertVisible(samples.slice(afterSelection));
    await expect(page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`)).toHaveAttribute("d", /.+/);
  });
});
