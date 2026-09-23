import { expect, test } from "@playwright/test";

test("health remains reachable", async ({ request }) => {
  const health = await request.get("/api/health");
  await expect(health).toBeOK();
  await expect(health.json()).resolves.toEqual({ apiVersion: "v1", service: "scoperoom-ai", status: "ok" });
});

test("blank workspace exposes its landmarks and truthful empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible();
  await expect(page.getByText("Nothing has been added to this canvas yet.")).toBeVisible();
  await expect(page.getByText("No project is connected yet.")).toBeVisible();
  expect(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor)).toBe("rgb(25, 28, 26)");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("narrow workspace keeps every section reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your starting point" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project details" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});
