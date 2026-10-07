import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult } from "../src/client/api.ts";
import type { ProjectStatusView } from "../src/features/projects/contracts/project.ts";
import { createRunResources } from "../src/features/proposals/ui/run-resources.ts";
import type { RunPage, RunView } from "../src/features/proposals/contracts/tasks.ts";

const status = (over: Partial<ProjectStatusView> = {}): ProjectStatusView => ({
  viewerId: "viewer", status: "ACTIVE", role: "OWNER", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1,
  designatedApproverId: null, currentDraftId: "draft", documentRevision: 1, layoutRevision: 1, realtimeEpoch: "epoch", eventSequence: 1,
  aiRevision: 1, sourcesRevision: 0, approvedSnapshotId: null, ...over,
});
const page = (id = "run-1"): RunPage => ({ runs: [{ id } as RunView], nextCursor: null });
const detail = (id = "run-1"): RunView => ({ id } as RunView);
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const unavailable = <T,>(): ApiResult<T> => ({ ok: false, code: "UNAVAILABLE", message: "Unavailable", status: 503, uncertain: false });
const missing = <T,>(): ApiResult<T> => ({ ok: false, code: "NOT_FOUND", message: "Not found", status: 404, uncertain: false });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type MissingTicket = { id: string; isLive: () => boolean };

test("a definitive missing Current run recovers only after its scoped page succeeds", async () => {
  let releasePage!: (value: ApiResult<RunPage>) => void;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => url.endsWith("ai-runs")
      ? new Promise<ApiResult<T>>((resolve) => { releasePage = resolve as (value: ApiResult<RunPage>) => void; })
      : Promise.resolve(missing<T>()),
    adoptPage: () => undefined,
    adoptRun: () => undefined,
    onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  resources.selectRun("gone");
  const read = resources.reconcile(status(), () => true);
  await settle();
  assert.equal(recovered.length, 0, "a 404 alone cannot clear Current before scoped page evidence");
  releasePage(ok(page("latest")));
  await read;
  assert.equal(recovered[0]?.id, "gone");
  assert.equal(recovered[0]?.isLive(), true);
});

test("only a definitive missing union signals Current recovery", async () => {
  const failures: Array<ApiResult<RunView> | "throw"> = [
    { ok: false, code: "UNAUTHENTICATED", message: "Sign in", status: 401, uncertain: false },
    { ok: false, code: "FORBIDDEN", message: "Forbidden", status: 403, uncertain: false },
    unavailable(),
    { ok: false, code: "NETWORK", message: "Offline", status: 0, uncertain: true },
    { ok: false, code: "ABORTED", message: "Aborted", status: 0, uncertain: true },
    { ok: false, code: "UNAVAILABLE", message: "Malformed", status: 200, uncertain: true },
    { ok: false, code: "OTHER", message: "Unknown", status: 404, uncertain: false },
    { ok: false, code: "NOT_FOUND", message: "Uncertain", status: 404, uncertain: true },
    "throw",
  ];
  for (const failure of failures) {
    const recovered: MissingTicket[] = [], states: string[] = [];
    const resources = createRunResources({
      projectId: "project",
      apiRead: async <T,>(url: string) => {
        if (url.endsWith("ai-runs")) return ok(page("latest") as T);
        if (failure === "throw") throw new Error("aborted read");
        return failure as ApiResult<T>;
      },
      adoptPage: () => undefined,
      adoptRun: () => undefined,
      adoptReadState: (destination, state) => { if (destination === "current") states.push(state); },
      onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
    });
    resources.selectRun("gone");
    await resources.reconcile(status(), () => true);
    assert.deepEqual(recovered, []);
    assert.equal(states.at(-1), "error");
  }
});

test("a held definitive 404 cannot clear a replacement Current selection", async () => {
  const releaseDetails: Array<(value: ApiResult<RunView>) => void> = [];
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => url.endsWith("ai-runs") ? Promise.resolve(ok(page("latest") as T)) : new Promise<ApiResult<T>>((resolve) => { releaseDetails.push(resolve as (value: ApiResult<RunView>) => void); }),
    adoptPage: () => undefined,
    adoptRun: () => undefined,
    onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  const fence = () => true;
  resources.selectRun("gone");
  const read = resources.reconcile(status(), fence);
  await settle();
  resources.selectRun("replacement");
  resources.selectRun("gone");
  const newer = resources.reconcile(status(), fence);
  releaseDetails[0]!(missing());
  await read;
  assert.deepEqual(recovered, []);
  void newer;
});

test("a missing ticket becomes invalid before a deferred Current write when its fence, reconciliation, page or selection changes", async () => {
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({ projectId: "project", apiRead: async <T,>(url: string) => url.endsWith("ai-runs") ? ok(page("latest") as T) : missing<T>(), adoptPage: () => undefined, adoptRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); } });
  let fenceOpen = true;
  const fence = () => fenceOpen;
  resources.selectRun("gone");
  await resources.reconcile(status(), fence);
  await settle();
  const first = recovered[0]!;
  fenceOpen = false;
  assert.equal(first.isLive(), false, "the originating fence is checked again at the write");
  fenceOpen = true;
  await resources.reconcile(status({ documentRevision: 2 }), fence);
  assert.equal(first.isLive(), false, "a newer status key and reconciliation cannot consume the old ticket");
  const second = recovered.at(-1)!;
  resources.retry();
  assert.equal(second.isLive(), false, "clearing scoped page evidence cannot leave an old ticket eligible");
  await resources.reconcile(status({ documentRevision: 2 }), fence);
  const third = recovered.at(-1)!;
  resources.selectRun("replacement");
  resources.selectRun("gone");
  await resources.reconcile(status({ documentRevision: 2 }), fence);
  assert.equal(third.isLive(), false, "an A-to-B-to-A selection creates a new epoch");
});

test("a missing detail requires a fresh matching page when only an old same-AI-revision page exists", async () => {
  let pageReads = 0, releaseFresh!: (value: ApiResult<RunPage>) => void;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => {
      if (!url.endsWith("ai-runs")) return Promise.resolve(missing<T>());
      pageReads++;
      return pageReads === 1 ? Promise.resolve(ok(page("latest") as T)) : new Promise<ApiResult<T>>((resolve) => { releaseFresh = resolve as (value: ApiResult<RunPage>) => void; });
    },
    adoptPage: () => undefined, adoptRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  const fence = () => true;
  await resources.reconcile(status(), fence);
  resources.selectRun("gone");
  await resources.reconcile(status({ documentRevision: 2 }), fence);
  await settle();
  assert.equal(pageReads, 2);
  assert.deepEqual(recovered, []);
  releaseFresh(unavailable());
  await settle();
  assert.deepEqual(recovered, [], "a fresh scoped page failure keeps Current pinned for retry");
});

test("a History-first shared missing flight can signal matching Current without letting History recover it", async () => {
  let releaseDetail!: (value: ApiResult<RunView>) => void;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => url.endsWith("ai-runs") ? Promise.resolve(ok(page("latest") as T)) : new Promise<ApiResult<T>>((resolve) => { releaseDetail = resolve as (value: ApiResult<RunView>) => void; }),
    adoptPage: () => undefined, adoptRun: () => undefined, adoptHistoryRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  const fence = () => true;
  resources.selectHistory("gone");
  const history = resources.reconcile(status(), fence);
  await settle();
  resources.selectRun("gone");
  const current = resources.reconcile(status(), fence);
  releaseDetail(missing());
  await Promise.all([history, current]);
  await settle();
  assert.equal(recovered[0]?.id, "gone");
});

test("an overlapping same-status reconcile that joins the held detail still recovers Current", async () => {
  let releasePage!: (value: ApiResult<RunPage>) => void, releaseDetail!: (value: ApiResult<RunView>) => void;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => new Promise<ApiResult<T>>((resolve) => {
      if (url.endsWith("ai-runs")) releasePage = resolve as (value: ApiResult<RunPage>) => void;
      else releaseDetail = resolve as (value: ApiResult<RunView>) => void;
    }),
    adoptPage: () => undefined, adoptRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  const fence = () => true;
  resources.selectRun("gone");
  const first = resources.reconcile(status(), fence);
  const second = resources.reconcile(status(), fence);
  releasePage(ok(page("latest")));
  await settle();
  releaseDetail(missing());
  await Promise.all([first, second]);
  assert.equal(recovered.length, 0, "the shared older page is not evidence for the newer reconciliation");
  releasePage(ok(page("latest")));
  await settle();
  assert.equal(recovered[0]?.id, "gone", "the newer reconciliation of the same selection epoch owns the shared 404");
  assert.equal(recovered[0]?.isLive(), true);
});

test("an invalidated G1 404 cannot mint a G2 recovery ticket after G2 has matching page evidence", async () => {
  let releaseFirst!: (value: ApiResult<RunView>) => void, releaseSecond!: (value: ApiResult<RunView>) => void, detailReads = 0;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => {
      if (url.endsWith("ai-runs")) return Promise.resolve(ok(page("latest") as T));
      return new Promise<ApiResult<T>>((resolve) => {
        if (detailReads++ === 0) releaseFirst = resolve as (value: ApiResult<RunView>) => void;
        else releaseSecond = resolve as (value: ApiResult<RunView>) => void;
      });
    },
    adoptPage: () => undefined, adoptRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  let firstFenceOpen = true;
  const firstFence = () => firstFenceOpen, secondFence = () => true;
  resources.selectRun("gone");
  const g1 = resources.reconcile(status(), firstFence);
  await settle();
  firstFenceOpen = false;
  resources.retry();
  const g2 = resources.reconcile(status({ documentRevision: 2 }), secondFence);
  await settle();
  releaseFirst(missing());
  await settle();
  assert.equal(recovered.length, 0, "an old fenced response cannot borrow G2 status and page evidence");
  releaseSecond(missing());
  await Promise.all([g1, g2]);
  assert.equal(recovered[0]?.id, "gone", "the genuinely matching G2 404 still recovers Current");
});

test("a G1 404 cannot mint recovery from a changed key on the same live Sync fence", async () => {
  let releaseFirst!: (value: ApiResult<RunView>) => void, releaseSecond!: (value: ApiResult<RunView>) => void, detailReads = 0;
  const recovered: MissingTicket[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => {
      if (url.endsWith("ai-runs")) return Promise.resolve(ok(page("latest") as T));
      return new Promise<ApiResult<T>>((resolve) => {
        if (detailReads++ === 0) releaseFirst = resolve as (value: ApiResult<RunView>) => void;
        else releaseSecond = resolve as (value: ApiResult<RunView>) => void;
      });
    },
    adoptPage: () => undefined, adoptRun: () => undefined, onMissingCurrent: (ticket: MissingTicket) => { recovered.push(ticket); },
  });
  const sharedFence = () => true;
  resources.selectRun("gone");
  const g1 = resources.reconcile(status(), sharedFence);
  await settle();
  resources.retry();
  const g2 = resources.reconcile(status({ documentRevision: 2 }), sharedFence);
  await settle();
  releaseFirst(missing());
  await settle();
  assert.equal(recovered.length, 0, "an old key cannot borrow a later reconciliation under the same Sync fence");
  releaseSecond(missing());
  await Promise.all([g1, g2]);
  assert.equal(recovered[0]?.id, "gone");
});

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
  let current = true;
  let late: ((value: ApiResult<RunPage>) => void) | undefined;
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>() => !late
      ? new Promise<ApiResult<T>>((resolve) => { late = resolve as (value: ApiResult<RunPage>) => void; })
      : Promise.resolve(ok(page() as T)),
    adoptPage: (value) => { pages.push(value); },
    adoptRun: () => undefined,
  });
  const pending = resources.reconcile(status(), () => current);
  current = false;
  late!({ ok: false, code: "UNAUTHENTICATED", message: "Sign in", status: 401, uncertain: false });
  await pending;
  assert.deepEqual(pages, []);
  await resources.reconcile(status(), () => true);
  assert.deepEqual(pages, [page()]);
});
test("a newer status cursor fences held page and run reads even within one generation", async () => {
  const held: Array<{ url: string; resolve: (value: ApiResult<RunPage | RunView>) => void }> = [];
  const adopted: string[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>(url: string) => new Promise<ApiResult<T>>((resolve) => { held.push({ url, resolve: resolve as (value: ApiResult<RunPage | RunView>) => void }); }),
    adoptPage: () => { adopted.push("page"); }, adoptRun: (value) => { if (value) adopted.push("run"); },
  });
  resources.selectRun("run-1");
  const fence = () => true;
  const first = resources.reconcile(status(), fence);
  const next = status({ aiRevision: 2, documentRevision: 2 });
  const second = resources.reconcile(next, fence);
  assert.equal(held.length, 3, "the new cursor gets its own detail while the held page transport remains shared");
  for (const request of held.splice(0)) request.resolve(ok(request.url.endsWith("run-1") ? detail() : page()));
  await Promise.all([first, second]);
  assert.deepEqual(adopted, ["run"], "only the matching newer detail can adopt while the old page is fenced");
  const retry = resources.reconcile(next, fence);
  assert.equal(held.length, 1, "the unloaded page retries without re-reading the adopted detail");
  for (const request of held.splice(0)) request.resolve(ok(request.url.endsWith("run-1") ? detail() : page()));
  await retry;
  assert.deepEqual(adopted, ["run", "page"]);
});

test("lifecycle and replaced-draft status changes reload selected run applicability", async () => {
  const adopted: string[] = [];
  let applicability = "APPLICABLE";
  const resources = createRunResources({
    projectId: "project",
    apiRead: async <T,>(url: string) => ok((url.endsWith("run-1") ? { ...detail(), applicability } : page()) as T),
    adoptPage: () => undefined,
    adoptRun: (value) => { if (value) adopted.push(value.applicability); },
  });
  resources.selectRun("run-1");
  await resources.reconcile(status(), () => true);
  applicability = "UNAVAILABLE";
  await resources.reconcile(status({ status: "ARCHIVED" }), () => true);
  applicability = "STALE";
  await resources.reconcile(status({ currentDraftId: "replacement" }), () => true);
  assert.deepEqual(adopted, ["APPLICABLE", "UNAVAILABLE", "STALE"]);
});

test("History shares already loaded Current detail without depending on a later cursor", async () => {
  const requests: string[] = [], history: Array<RunView | null> = [];
  const resources = createRunResources({ projectId: "project", apiRead: async <T,>(url: string) => { requests.push(url); return ok((url.endsWith("run-1") ? detail() : page()) as T); }, adoptPage: () => {}, adoptRun: () => {}, adoptHistoryRun: value => history.push(value) });
  const fence = () => true; resources.selectRun("run-1"); await resources.reconcile(status(), fence);
  resources.selectHistory("run-1"); await resources.reconcile(status(), () => true);
  assert.equal(history.at(-1)?.id, "run-1"); assert.equal(requests.filter(url => url.endsWith("run-1")).length, 1);
});

test("a shared held read adopts History independently when Current switches", async () => {
  const history: Array<RunView | null> = []; let resolve!: (result: ApiResult<RunView>) => void;
  const resources = createRunResources({ projectId: "project", apiRead: <T,>(url: string) => url.endsWith("run-1") ? new Promise<ApiResult<T>>(done => { resolve = done as typeof resolve; }) : Promise.resolve(ok(page() as T)), adoptPage: () => {}, adoptRun: () => {}, adoptHistoryRun: value => history.push(value) });
  const fence = () => true; resources.selectRun("run-1"); resources.selectHistory("run-1"); const flight = resources.reconcile(status(), fence);
  resources.selectRun("run-2"); resolve(ok(detail())); await flight;
  assert.equal(history.at(-1)?.id, "run-1");
});

test("overlapping History reads deduplicate and obsolete identity failures cannot alter it", async () => {
  const held: Array<{url: string; resolve: (value: ApiResult<RunView>) => void}> = []; const history: Array<RunView | null> = [];
  const resources = createRunResources({ projectId: "project", apiRead: <T,>(url: string) => url.endsWith("ai-runs") ? Promise.resolve(ok(page() as T)) : new Promise<ApiResult<T>>(resolve => held.push({url,resolve: resolve as (value: ApiResult<RunView>) => void})), adoptPage: () => {}, adoptRun: () => {}, adoptHistoryRun: value => history.push(value) });
  const fence = () => true; resources.selectHistory("run-1"); const a = resources.reconcile(status(),fence), b = resources.reconcile(status(),fence);
  assert.equal(held.length,1); resources.selectHistory("run-2"); const c = resources.reconcile(status(),fence);
  held[0].resolve(unavailable()); held[1].resolve(ok(detail("run-2"))); await Promise.all([a,b,c]); assert.equal(history.at(-1)?.id,"run-2");
});

test("resource reads publish held loading, failure and explicit unchanged-key retry states", async () => {
  const states: string[]=[]; let fail=true;
  const resources=createRunResources({projectId:"project",apiRead:async<T,>()=>fail?unavailable<T>():ok(page() as T),adoptPage:()=>{},adoptRun:()=>{},adoptReadState:(destination: string,state: string)=>states.push(destination+":"+state)});
  const fence=()=>true; await resources.reconcile(status(),fence); assert.deepEqual(states,["page:loading","page:error"]);
  fail=false; resources.retry(); await resources.reconcile(status(),fence); assert.deepEqual(states.slice(-2),["page:loading","page:loaded"]);
});

test("History generation and status changes fence stale success and failure independently",async()=>{
  const held:Array<{resolve:(value:ApiResult<RunView>)=>void}>=[],adopted:Array<RunView|null>=[],states:string[]=[];
  const resources=createRunResources({projectId:'project',apiRead:<T,>(url:string)=>url.endsWith('ai-runs')?Promise.resolve(ok(page() as T)):new Promise<ApiResult<T>>(resolve=>held.push({resolve:resolve as (value:ApiResult<RunView>)=>void})),adoptPage:()=>{},adoptRun:()=>{},adoptHistoryRun:value=>adopted.push(value),adoptReadState:(destination,state)=>{if(destination==='history')states.push(state);}});
  resources.selectHistory('run-1');let alive=true;const first=resources.reconcile(status(),()=>alive);alive=false;const fence=()=>true;const second=resources.reconcile(status({aiRevision:2}),fence);held[0].resolve(unavailable());held[1].resolve(ok(detail()));await Promise.all([first,second]);assert.equal(adopted.at(-1)?.id,'run-1');assert.equal(states.includes('error'),false);
  const third=resources.reconcile(status({approvedSnapshotId:'new'}),fence);held[2].resolve(unavailable());await third;assert.equal(states.at(-1),'error');const retry=resources.reconcile(status({approvedSnapshotId:'new'}),fence);held[3].resolve(ok(detail()));await retry;assert.equal(states.at(-1),'loaded');
});
