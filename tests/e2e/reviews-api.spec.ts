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
