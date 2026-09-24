import { expect, test } from "@playwright/test";

test("health remains reachable without signing in", async ({ request }) => {
  const health = await request.get("/api/health");
  await expect(health).toBeOK();
  await expect(health.json()).resolves.toEqual({ apiVersion: "v1", service: "scoperoom-ai", status: "ok" });
});
