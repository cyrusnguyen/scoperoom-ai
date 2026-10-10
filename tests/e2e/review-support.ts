import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { appUrl, seedStudioChanges } from "./support";
export const reviewHeaders = () => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });
export async function readyCandidate(page: Page, projectId: string, evidence = false) {
  const flowId = randomUUID(), startId = randomUUID(), outcomeId = randomUUID();
  const draftId = await seedStudioChanges(page, projectId, [
    {command:"CREATE_FLOW",payload:{title:"Saved checkout",purpose:"Captured checkout",classification:"USER_JOURNEY",inclusion:"INCLUDED"},proposedIds:[flowId]},
    {command:"ADD_NODE",payload:{flowId,kind:"START",label:"Begin",description:"",actorLabel:""},proposedIds:[startId]},
    {command:"ADD_NODE",payload:{flowId,kind:"OUTCOME",label:"Done",description:"",actorLabel:""},proposedIds:[outcomeId]},
    {command:"ADD_EDGE",payload:{flowId,fromId:startId,toId:outcomeId,condition:""},proposedIds:[randomUUID()]},
  ]);
  const path = `/api/projects/${projectId}/drafts/${draftId}`;
  let source: {sourceId:string;sourceVersionId:string;version:number} | null = null;
  if (evidence) {
    const response = await page.request.post(`/api/projects/${projectId}/sources`, {headers:reviewHeaders(),data:{title:"Captured brief",text:Array.from({length:205},(_,i)=>`Evidence line ${i+1}`).join("\n")+"\n"}});
    expect(response.status()).toBe(201); source = await response.json();
    const draft = await (await page.request.get(path)).json();
    const requirement = await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: {
      commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: draft.documentRevision,
      payload: { title: "Captured requirement", statement: "Keep captured evidence", category: "FUNCTIONAL", inclusion: "INCLUDED", ownerId: null, verification: null,
        sourceRefs: [{ sourceVersionId: source!.sourceVersionId, startLine: 105, endLine: 105, excerpt: "Evidence line 105" }] },
    } });
    expect(requirement.status()).toBe(200);
    const saved = await (await page.request.get(path)).json();
    const req = Object.values(saved.document.requirements)[0] as { id: string; version: number };
    expect((await page.request.post(`${path}/commands`, { headers: reviewHeaders(), data: { commandSchemaVersion: 1, command: "CONFIRM_REQUIREMENT", expectedEntityVersion: req.version, payload: { requirementId: req.id } } })).status()).toBe(200);

  }
  const flow = (await (await page.request.get(path)).json()).document.flows[flowId];
  expect((await page.request.post(`${path}/commands`, { headers:reviewHeaders(),data:{commandSchemaVersion:1,command:"CONFIRM_FLOW",expectedEntityVersion:flow.version,payload:{flowId}}})).status()).toBe(200);
  const statusResponse = await page.request.get(`/api/projects/${projectId}/status`);
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect((await page.request.patch(`/api/projects/${projectId}/approval-policy`,{headers:reviewHeaders(),data:{designatedApproverId:status.viewerId,expectedApprovalPolicyVersion:status.approvalPolicyVersion}})).status()).toBe(200);
  return {draftId,path,flowId,startId,outcomeId,source};
}
export async function openReview(page: Page, projectId: string) {
  await page.goto(`/app/projects/${projectId}`);
  await expect(page.locator("#studio-flow-title")).toBeVisible();
  const inspect=page.getByRole("button",{name:"Inspect",exact:true});
  if(await inspect.getAttribute("aria-pressed")!=="true") await inspect.click();
  await page.getByRole("tab",{name:"Review",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Review saved scope",exact:true})).toBeVisible();
}
export async function freezeInUi(page: Page) {
  await page.getByRole("button",{name:"Preview saved scope",exact:true}).click();
  await expect(page.getByText("Saved scope is ready to freeze.",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Freeze candidate",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Candidate - not approved",exact:true})).toBeVisible();
  await expect(page.getByText("Freeze candidate: saved.",{exact:true})).toBeVisible();
}
export async function freezeViaApi(page:Page,projectId:string,draftId:string) {
  const status=await (await page.request.get(`/api/projects/${projectId}/status`)).json();
  const guards={expectedDocumentRevision:status.documentRevision,expectedLayoutRevision:status.layoutRevision,expectedParentSnapshotId:status.approvedSnapshotId,expectedApprovalPolicyVersion:status.approvalPolicyVersion};
  const response=await page.request.post(`/api/projects/${projectId}/drafts/${draftId}/reviews`,{headers:reviewHeaders(),data:guards});
  expect(response.status()).toBe(201); return response.json();
}
