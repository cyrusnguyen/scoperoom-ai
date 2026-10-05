import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult } from "../src/client/api.ts";
import type { ProjectStatusView } from "../src/features/projects/contracts/project.ts";
import { createRunResources } from "../src/features/proposals/ui/run-resources.ts";
import type { RunPage, RunView } from "../src/features/proposals/contracts/tasks.ts";

const status = (over: Partial<ProjectStatusView> = {}): ProjectStatusView => ({
  viewerId: "viewer", status: "ACTIVE", role: "OWNER", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1,
  designatedApproverId: null, currentDraftId: "draft", documentRevision: 1, layoutRevision: 1, realtimeEpoch: "epoch", eventSequence: 1,
  aiRevision: 1, approvedSnapshotId: null, ...over,
});
const page = (id = "run-1"): RunPage => ({ runs: [{ id } as RunView], nextCursor: null });
const detail = (id = "run-1"): RunView => ({ id } as RunView);
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const unavailable = <T,>(): ApiResult<T> => ({ ok: false, code: "UNAVAILABLE", message: "Unavailable", status: 503, uncertain: false });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a failed resource read retries unchanged cursors and never advances them before adoption", async () => {
  const requests: string[] = [], pages: RunPage[] = [];
  let attempt = 0;
  const resources = createRunResources({
    projectId: "project",
    apiRead: async <T,>(url: string) => {
      requests.push(url);
      return (attempt++ === 0 ? unavailable<T>() : ok(page() as T));
    },
    adoptPage: (value) => { pages.push(value); },
    adoptRun: () => undefined,
  });
  const fence = () => true;
  await resources.reconcile(status(), fence);
  await resources.reconcile(status(), fence);
  assert.deepEqual(requests, ["/api/projects/project/ai-runs", "/api/projects/project/ai-runs"]);
  assert.deepEqual(pages, [page()]);
});

test("a changed generation or selected run cannot adopt a late resource response", async () => {
  const pending: Array<{ url: string; resolve: (value: ApiResult<RunPage | RunView>) => void }> = [];
  const pages: RunPage[] = [], details: Array<RunView | null> = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => new Promise<ApiResult<T>>((resolve) => { pending.push({ url, resolve: resolve as (value: ApiResult<RunPage | RunView>) => void }); }),
    adoptPage: (value) => { pages.push(value); },
    adoptRun: (value) => { details.push(value); },
  });
  resources.selectRun("run-1");
  let current = true;
  const old = resources.reconcile(status(), () => current);
  await settle();
  current = false;
  resources.selectRun("run-2");
  const fresh = resources.reconcile(status({ aiRevision: 2, approvedSnapshotId: "baseline" }), () => true);
  await settle();
  while (pending.length) {
    const request = pending.shift()!;
    request.resolve(ok(request.url.endsWith("/run-1") ? detail("run-1") : request.url.endsWith("/run-2") ? detail("run-2") : page("current")));
  }
  await Promise.all([old, fresh]);
  assert.deepEqual(pages, [page("current")]);
  assert.equal(details.every((value) => value?.id !== "run-1"), true);
});

test("a baseline-only change reloads the selected run while AI-only changes never read the draft", async () => {
  const requests: string[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: async <T,>(url: string) => { requests.push(url); return ok((url.endsWith("run-1") ? detail() : page()) as T); },
    adoptPage: () => undefined,
    adoptRun: () => undefined,
  });
  resources.selectRun("run-1");
  await resources.reconcile(status(), () => true);
  await resources.reconcile(status({ approvedSnapshotId: "baseline" }), () => true);
  await resources.reconcile(status({ aiRevision: 2, approvedSnapshotId: "baseline" }), () => true);
  assert.deepEqual(requests, [
    "/api/projects/project/ai-runs", "/api/projects/project/ai-runs/run-1",
    "/api/projects/project/ai-runs/run-1",
    "/api/projects/project/ai-runs", "/api/projects/project/ai-runs/run-1",
  ]);
});

test("a late 401 after sign-out leaves safe state unchanged and is retried", async () => {
  const pages: RunPage[] = [];
  let first = true;
  const resources = createRunResources({
    projectId: "project",
    apiRead: async <T,>() => first ? (first = false, { ok: false, code: "UNAUTHENTICATED", message: "Sign in", status: 401, uncertain: false } as ApiResult<T>) : ok(page() as T),
    adoptPage: (value) => { pages.push(value); },
    adoptRun: () => undefined,
  });
  await resources.reconcile(status(), () => false);
  await resources.reconcile(status(), () => true);
  assert.deepEqual(pages, [page()]);
});
