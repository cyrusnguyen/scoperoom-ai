import { randomUUID } from "node:crypto";
import { request as nodeRequest } from "node:http";
import { test as collaborationTest } from "./collaboration-fixtures";
import { expect } from "@playwright/test";
import { test } from "./studio-fixtures";
import { appUrl, createProjectViaApi, e2eReady } from "./support";
import { readyCandidate, freezeViaApi, reviewHeaders } from "./review-support";

test.skip(!e2eReady, "Requires isolated local Supabase Auth and database URLs");

test("nested foreign draft and review IDs disclose no candidate and mutate neither project",async({page})=>{
  const one=await createProjectViaApi(page,"Candidate API one"),two=await createProjectViaApi(page,"Candidate API two");
  const a=await readyCandidate(page,one),b=await readyCandidate(page,two),frozen=await freezeViaApi(page,one,a.draftId);
  const before=await(await page.request.get(`/api/projects/${one}/reviews/${frozen.reviewId}`)).json();
  expect((await page.request.get(`/api/projects/${two}/reviews/${frozen.reviewId}`)).status()).toBe(404);
  expect((await page.request.post(`/api/projects/${two}/reviews/${frozen.reviewId}/withdraw`,{headers:reviewHeaders(),data:{expectedReviewVersion:1,reason:"Foreign"}})).status()).toBe(404);
  const status=await(await page.request.get(`/api/projects/${two}/status`)).json();
  const data={expectedDocumentRevision:status.documentRevision,expectedLayoutRevision:status.layoutRevision,expectedParentSnapshotId:null,expectedApprovalPolicyVersion:status.approvalPolicyVersion};
  for(const action of ["review-preview","reviews"]) expect((await page.request.post(`/api/projects/${two}/drafts/${a.draftId}/${action}`,{headers:reviewHeaders(),data})).status()).toBe(404);
  expect(await(await page.request.get(`/api/projects/${one}/reviews/${frozen.reviewId}`)).json()).toEqual(before);
  expect((await(await page.request.get(`/api/projects/${two}/reviews`)).json()).items).toEqual([]);
  expect(b.draftId).not.toBe(a.draftId);
});

test("preview and freeze reject malformed guards, extra fields and oversized UTF8 bodies",async({page})=>{
  const projectId=await createProjectViaApi(page,"Candidate API bounds"),{path}=await readyCandidate(page,projectId);
  const s=await(await page.request.get(`/api/projects/${projectId}/status`)).json(),guards={expectedDocumentRevision:s.documentRevision,expectedLayoutRevision:s.layoutRevision,expectedParentSnapshotId:null,expectedApprovalPolicyVersion:s.approvalPolicyVersion};
  for(const action of ["review-preview","reviews"]) {
    for(const data of [{...guards,expectedDocumentRevision:0},{...guards,expectedLayoutRevision:1.5},{...guards,expectedParentSnapshotId:"foreign"},{...guards,expectedApprovalPolicyVersion:"2"},{...guards,document:{}}]) {
      const response=await page.request.post(`${path}/${action}`,{headers:reviewHeaders(),data});expect(response.status()).toBe(400);expect((await response.json()).error.code).toBe("INVALID_INPUT");
    }
    const oversized=await page.request.post(`${path}/${action}`,{headers:{...reviewHeaders(),"Content-Type":"application/json"},data:JSON.stringify({...guards,extra:"🙂".repeat(1100)})});
    expect(oversized.status()).toBe(413);expect((await oversized.json()).error.details.limit).toBe("REVIEW_BODY");
  }
  expect((await(await page.request.get(`/api/projects/${projectId}/reviews`)).json()).items).toEqual([]);
});

test("withdraw rejects malformed version, reason codepoint limit and request byte limit",async({page})=>{
  const projectId=await createProjectViaApi(page,"Withdraw API bounds"),{draftId}=await readyCandidate(page,projectId),frozen=await freezeViaApi(page,projectId,draftId);
  const path=`/api/projects/${projectId}/reviews/${frozen.reviewId}/withdraw`;
  for(const data of [{expectedReviewVersion:0,reason:"Reason"},{expectedReviewVersion:1,reason:""},{expectedReviewVersion:1,reason:"🙂".repeat(4001)}]) expect((await page.request.post(path,{headers:reviewHeaders(),data})).status()).toBe(400);
  const oversized=await page.request.post(path,{headers:{...reviewHeaders(),"Content-Type":"application/json"},data:JSON.stringify({expectedReviewVersion:1,reason:"x".repeat(33000)})});
  expect(oversized.status()).toBe(413);expect((await oversized.json()).error.details.limit).toBe("WITHDRAW_BODY");
  expect((await(await page.request.get(`/api/projects/${projectId}/reviews/${frozen.reviewId}`)).json()).review.state).toBe("OPEN");
  expect((await page.request.post(path,{headers:reviewHeaders(),data:{expectedReviewVersion:1,reason:"🙂".repeat(4000)}})).status()).toBe(200);
});

test("keyless preview uses current membership and a stale guard refuses before capture",async({page})=>{
  const projectId=await createProjectViaApi(page,"Keyless preview"),{path}=await readyCandidate(page,projectId);
  const s=await(await page.request.get(`/api/projects/${projectId}/status`)).json(),guards={expectedDocumentRevision:s.documentRevision,expectedLayoutRevision:s.layoutRevision,expectedParentSnapshotId:null,expectedApprovalPolicyVersion:s.approvalPolicyVersion};
  const response=await page.request.post(`${path}/review-preview`,{headers:{Origin:appUrl},data:guards});expect(response.status()).toBe(200);expect((await response.json()).guards).toEqual(guards);
  expect((await page.request.post(`${path}/reviews`,{headers:reviewHeaders(),data:{...guards,expectedLayoutRevision:guards.expectedLayoutRevision+1}})).status()).toBe(409);
  expect((await(await page.request.get(`/api/projects/${projectId}/reviews`)).json()).items).toEqual([]);
});

test("decision route requires same origin, authentication, key and strict exact-candidate guards", async ({ page, browser }) => {
  const projectId = await createProjectViaApi(page, "Decision API guards");
  const { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  const path = `/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`;
  const data = { decision: "REQUEST_CHANGES", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash, reason: "Needs revision" };
  const anonymous = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  try { expect((await anonymous.request.post(path, { headers: reviewHeaders(), data })).status()).toBe(401); } finally { await anonymous.close(); }
  for (const Origin of ["", "https://foreign.example"]) expect((await page.request.post(path, { headers: { ...reviewHeaders(), Origin }, data })).status()).toBe(403);
  expect((await page.request.post(path, { headers: { Origin: appUrl }, data })).status()).toBe(400);
  for (const invalid of [
    { ...data, expectedReviewVersion: 0 }, { ...data, expectedReviewVersion: 1.5 },
    { ...data, expectedReviewHash: "bad" }, { ...data, decision: "WITHDRAW" },
    { ...data, reason: "" }, { ...data, reason: "🙂".repeat(4001) },
    { ...data, extra: true }, { ...data, key: randomUUID() },
    { decision: "REJECT", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash },
  ]) {
    const response = await page.request.post(path, { headers: reviewHeaders(), data: invalid });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_INPUT");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  for (const stale of [{ ...data, expectedReviewVersion: 2 }, { ...data, expectedReviewHash: "a".repeat(64) }]) expect((await page.request.post(path, { headers: reviewHeaders(), data: stale })).status()).toBe(409);
  expect((await page.request.post(`/api/projects/${randomUUID()}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data })).status()).toBe(404);
  const other = await createProjectViaApi(page, "Foreign decision parent");
  expect((await page.request.post(`/api/projects/${other}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data })).status()).toBe(404);
  const unchanged = await (await page.request.get(`/api/projects/${projectId}/reviews/${frozen.reviewId}`)).json();
  expect(unchanged.review.state).toBe("OPEN"); expect(unchanged.decision).toBeNull();
  const accepted = await page.request.post(path, { headers: reviewHeaders(), data: { ...data, reason: "🙂".repeat(4000) } });
  expect(accepted.status()).toBe(200); expect(accepted.headers()["cache-control"]).toContain("no-store");
});

test("decision route bounds both declared and chunked UTF8 bodies at 32 KiB", async ({ page }) => {
  const projectId = await createProjectViaApi(page, "Decision API bounds");
  const { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId);
  const path = `/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`;
  const bytes = Buffer.from(JSON.stringify({ decision: "REJECT", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash, reason: "🙂".repeat(8300) }));
  const declared = await page.request.post(path, { headers: { ...reviewHeaders(), "Content-Type": "application/json" }, data: bytes });
  expect(declared.status()).toBe(413); expect((await declared.json()).error.details.limit).toBe("DECISION_BODY");
  const cookie = (await page.context().cookies(appUrl)).map(value => `${value.name}=${value.value}`).join("; ");
  const streamed = await new Promise<{ status: number; limit: string; cache: string | undefined }>((resolve, reject) => {
    const upload = nodeRequest(new URL(path, appUrl), { method: "POST", headers: { ...reviewHeaders(), Cookie: cookie, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, response => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, limit: JSON.parse(Buffer.concat(chunks).toString()).error.details.limit, cache: response.headers["cache-control"] }));
    });
    upload.on("error", reject); upload.write(bytes.subarray(0, 16000)); upload.end(bytes.subarray(16000));
  });
  expect(streamed.status).toBe(413); expect(streamed.limit).toBe("DECISION_BODY"); expect(streamed.cache).toContain("no-store");
  const unchanged = await (await page.request.get(`/api/projects/${projectId}/reviews/${frozen.reviewId}`)).json();
  expect(unchanged.review.state).toBe("OPEN"); expect(unchanged.decision).toBeNull();
});

collaborationTest("decision HTTP refuses nonapprovers and revoked members before receipt recovery", async ({ collaboration }) => {
  const { ownerPage, editorPage, projectId, removeEditor } = collaboration;
  const { draftId } = await readyCandidate(ownerPage, projectId);
  const frozen = await freezeViaApi(ownerPage, projectId, draftId);
  const path = `/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`;
  const data = { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash };
  expect((await editorPage.request.post(path, { headers: reviewHeaders(), data })).status()).toBe(403);
  const status = await (await ownerPage.request.get(`/api/projects/${projectId}/status`)).json();
  const editor = await (await editorPage.request.get(`/api/projects/${projectId}/status`)).json();
  expect((await ownerPage.request.patch(`/api/projects/${projectId}/approval-policy`, { headers: reviewHeaders(), data: { designatedApproverId: editor.viewerId, expectedApprovalPolicyVersion: status.approvalPolicyVersion } })).status()).toBe(200);
  const next = await freezeViaApi(ownerPage, projectId, draftId);
  const nextPath = `/api/projects/${projectId}/reviews/${next.reviewId}/decision`;
  const headers = reviewHeaders(), body = { ...data, expectedReviewHash: next.reviewHash };
  expect((await editorPage.request.post(nextPath, { headers, data: body })).status()).toBe(200);
  await removeEditor();
  expect((await editorPage.request.post(nextPath, { headers, data: body })).status()).toBe(404);
  expect((await editorPage.request.post(path, { headers: reviewHeaders(), data })).status()).toBe(404);
});


test("snapshot GET routes reject unpublished foreign and hostile paging identities",async({page})=>{
  const projectId=await createProjectViaApi(page,"Published API"),foreign=await createProjectViaApi(page,"Foreign baseline API");
  const {draftId}=await readyCandidate(page,projectId);const frozen=await freezeViaApi(page,projectId,draftId);
  const list=`/api/projects/${projectId}/snapshots`,detail=`${list}/${frozen.snapshotId}`;
  expect((await page.request.get(detail)).status()).toBe(404);
  expect((await page.request.get(`/api/projects/${foreign}/snapshots/${frozen.snapshotId}`)).status()).toBe(404);
  for(const query of ["?cursor=!","?state=APPROVED","?cursor=x&cursor=x","?cursor="+"x".repeat(257)]) expect((await page.request.get(list+query)).status()).toBe(400);
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`,{headers:reviewHeaders(),data:{decision:"APPROVE",expectedReviewVersion:1,expectedReviewHash:frozen.reviewHash}})).status()).toBe(200);
  const approved=await page.request.get(detail);expect(approved.status()).toBe(200);
  const result=await approved.json();expect(result.publicationSequence).toBe(1);expect(result.snapshot.id).toBe(frozen.snapshotId);expect(result.decision.reviewedHash).toBe(frozen.reviewHash);
  expect((await page.request.get(`/api/projects/${foreign}/snapshots/${frozen.snapshotId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/projects/${projectId.toUpperCase()}/snapshots/${frozen.snapshotId.toUpperCase()}`)).status()).toBe(200);
});

test("approved Markdown route returns exact authorized UTF8 bytes, safe attachment grammar and shared private headers", async ({ page, browser }) => {
  const title = "CON/Old 'scope' (🙂)\n.txt";
  const projectId = await createProjectViaApi(page, title), { draftId } = await readyCandidate(page, projectId);
  const frozen = await freezeViaApi(page, projectId, draftId), path = `/api/projects/${projectId}/snapshots/${frozen.snapshotId}/export?format=markdown`;
  const unapproved = await page.request.get(path); expect(unapproved.status()).toBe(404); expect(unapproved.headers()["content-type"]).toContain("application/json"); expect((await unapproved.json()).error.code).toBe("NOT_FOUND");
  expect((await page.request.post(`/api/projects/${projectId}/reviews/${frozen.reviewId}/decision`, { headers: reviewHeaders(), data: { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: frozen.reviewHash } })).status()).toBe(200);
  const result = await page.request.get(path), h = result.headers(), text = await result.text();
  expect(result.status()).toBe(200); expect(h["content-type"]).toBe("text/markdown; charset=utf-8"); expect(h["cache-control"]).toBe("private, no-store"); expect(h["x-request-id"]).toMatch(/^[\w-]{8,80}$/); expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["content-disposition"]).toBe("attachment; filename=\"approved-scope.md\"; filename*=UTF-8''CON_Old%20%27scope%27%20%28%F0%9F%99%82%29_.txt.md");
  expect(text).toContain("# Approved scope\n"); expect(text).toContain(frozen.reviewHash); expect(text).toContain("Captured checkout");
  expect(await (await page.request.get(path)).body()).toEqual(await result.body());
  for (const suffix of ["", "?format=native", "?format=markdown&format=markdown", "?format=markdown&extra=x"]) {
    const refused = await page.request.get(path.split("?")[0] + suffix); expect(refused.status()).toBe(400); expect((await refused.json()).error.code).toBe("INVALID_INPUT");
  }
  const foreign = await createProjectViaApi(page, "Foreign export"); expect((await page.request.get(`/api/projects/${foreign}/snapshots/${frozen.snapshotId}/export?format=markdown`)).status()).toBe(404);
  const anonymous = await browser.newContext({ baseURL: appUrl, storageState: { cookies: [], origins: [] } });
  try { const response = await anonymous.request.get(path); expect(response.status()).toBe(401); expect((await response.json()).error.code).toBe("UNAUTHENTICATED"); expect(response.headers()["cache-control"]).toBe("private, no-store"); } finally { await anonymous.close(); }
});
