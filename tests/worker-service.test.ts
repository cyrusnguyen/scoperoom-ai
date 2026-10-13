import assert from "node:assert/strict";
import test from "node:test";
import { isStaticAssetPath, isWorkerService, routeAllowed, workerRequestAllowed } from "../src/server/worker-service.ts";

test("only SCOPEROOM_SERVICE=worker is the worker service", () => {
  assert.equal(isWorkerService({ SCOPEROOM_SERVICE: "worker" }), true);
  for (const value of [undefined, "", "web", "Worker", " worker"]) assert.equal(isWorkerService({ SCOPEROOM_SERVICE: value }), false);
});

test("the worker serves /api/inngest and the two maintenance endpoints only; the web serves none of them", () => {
  for (const path of ["/api/inngest", "/api/internal/worker/repair", "/api/internal/worker/cleanup"]) {
    assert.equal(routeAllowed("worker", path), true, path);
    assert.equal(routeAllowed("web", path), false, path);
  }
  for (const path of ["/api/internal/worker", "/api/internal/worker/", "/api/internal/worker/runs", "/api/internal/worker/repair/x", "/api/internal/workerx/repair", "/api/projects", "/", "/login", "/app", "/api/health", "/api/inngestx", "/api/inngest/x"]) {
    assert.equal(routeAllowed("worker", path), false, path);
  }
  for (const path of ["/api/inngest/", "/api/inngest/x", "/api/internal/worker/", "/api/internal/worker/anything"]) assert.equal(routeAllowed("web", path), false, path);
  for (const path of ["/", "/api/projects", "/api/health"]) assert.equal(routeAllowed("web", path), true, path);
});

const secret = "s".repeat(32);
const worker = { SCOPEROOM_SERVICE: "worker", SCOPEROOM_WORKER_SECRET: secret };
test("a maintenance request needs the worker service, a secret of at least 32 characters and the exact bearer value", () => {
  assert.equal(workerRequestAllowed(`Bearer ${secret}`, worker), true);
  for (const header of [null, "", secret, `Bearer ${secret}x`, `Bearer ${"t".repeat(32)}`, `bearer ${secret}`, `Bearer  ${secret}`]) assert.equal(workerRequestAllowed(header, worker), false, String(header));
  assert.equal(workerRequestAllowed(`Bearer ${secret}`, { ...worker, SCOPEROOM_SERVICE: "web" }), false);
  assert.equal(workerRequestAllowed("Bearer short", { ...worker, SCOPEROOM_WORKER_SECRET: "short" }), false);
});

test("static asset paths are recognised by suffix so the proxy can skip them on the web service only", () => {
  for (const path of ["/favicon.ico", "/logo.svg", "/a/b.png", "/x.jpeg", "/x.gif", "/x.webp", "/api/projects/a/drafts/b.png"]) assert.equal(isStaticAssetPath(path), true, path);
  for (const path of ["/", "/api/inngest", "/api/projects", "/png", "/a.png/b", "/x.pngx"]) assert.equal(isStaticAssetPath(path), false, path);
});
