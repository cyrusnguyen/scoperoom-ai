import { expect, test } from "@playwright/test";

test("health and the truthful foundation shell are reachable", async ({ page, request }) => {
  const health = await request.get("/api/health");
  await expect(health).toBeOK();
  await expect(health.json()).resolves.toEqual({ apiVersion: "v1", service: "scoperoom-ai", status: "ok" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace coming soon" })).toBeVisible();
  await expect(page.getByText("Workspace tools are coming soon.")).toBeVisible();
});

test("skip link gives keyboard users the main landmark", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});