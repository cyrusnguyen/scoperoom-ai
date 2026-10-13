import assert from "node:assert/strict";
import test from "node:test";
import { isWorkerService, routeAllowed } from "../src/server/worker-service.ts";

test("only SCOPEROOM_SERVICE=worker is the worker service", () => {
  assert.equal(isWorkerService({ SCOPEROOM_SERVICE: "worker" }), true);
  for (const value of [undefined, "", "web", "Worker", " worker"]) assert.equal(isWorkerService({ SCOPEROOM_SERVICE: value }), false);
});

test("the worker project serves only /api/inngest and the web project never does", () => {
  assert.equal(routeAllowed("worker", "/api/inngest"), true);
  for (const path of ["/", "/login", "/app", "/api/health", "/api/projects", "/api/inngestx", "/api/inngest/x"]) assert.equal(routeAllowed("worker", path), false, path);
  for (const path of ["/api/inngest", "/api/inngest/", "/api/inngest/x"]) assert.equal(routeAllowed("web", path), false, path);
  for (const path of ["/", "/api/projects", "/api/health"]) assert.equal(routeAllowed("web", path), true, path);
});
