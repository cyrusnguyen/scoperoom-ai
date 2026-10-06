import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL, loadCorpus, selectCases, budgetGateway, assess, outcomeCounts } from "./evaluation/run.mts";
import { resultFixture } from "./support/ai-results.ts";
import { buildModelRequest } from "../src/features/proposals/domain/model-request.ts";
import { canonicalJson, sha256 } from "../src/features/proposals/domain/capture.ts";
const request = () => { const capture = resultFixture().generate(); capture.versions.model = MODEL; return buildModelRequest({id: "00000000-0000-4000-8000-000000000001", model: MODEL, capture}, 1000); };
const state = () => ({purpose: "24 synthetic evaluation cases plus two product journeys", authorizationDate: "2026-10-05", scope: "No retries or calibration beyond cumulative budget", model: MODEL, authorizedCalls: 26, reservedCalls: 0, records: []});
async function budgetTest(run: (journal: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "scoperoom-evaluation-")); const journal = join(dir, "budget.json");
  writeFileSync(journal, JSON.stringify(state())); try { await run(journal); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("frozen corpus has 24 executable canonical captures, balanced development and held-out partitions", () => { const corpus = loadCorpus(); assert.equal(corpus.length, 24); assert.equal(corpus.filter(item => item.partition === "development").length, 16); assert.equal(corpus.filter(item => item.partition === "held-out").length, 8); assert.equal(corpus.filter(item => item.capture.taskType === "PROPOSE_FLOW").length, 12); assert.equal(corpus.filter(item => item.capture.taskType === "REFINE_FLOW_SELECTION").length, 12); });
test("bounded case selection rejects duplicates, unknowns and implicit live authority", () => {
  assert.deepEqual(selectCases([], ["G01", "I01"]), ["G01", "I01"]);
  for (const args of [["--only=G01,G01"], ["--only=X"], ["--live"], ["--limit=0"], ["--unexpected"]]) assert.throws(() => selectCases(args, ["G01", "I01"]));
});
test("physical inference is fsynced before transport and cannot repeat after restart", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const transport: typeof fetch = async () => { calls++; const saved = JSON.parse(readFileSync(journal, "utf8")); assert.equal(saved.reservedCalls, 1); assert.equal(saved.records[0].id, "G01"); throw new Error("uncertain provider failure"); };
  const options = {journal, id: "G01", kind: "corpus" as const, apiKey: "synthetic-test-key", transport, onDenied: () => denied++};
  await budgetGateway(options).generate(request(), new AbortController().signal);
  await budgetGateway(options).generate(request(), new AbortController().signal);
  assert.equal(calls, 1); assert.equal(denied, 1); assert.equal(JSON.parse(readFileSync(journal, "utf8")).reservedCalls, 1);
}));
test("malformed, exhausted and mismatched journal authority never reaches transport", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  for (const value of ["{", JSON.stringify({...state(), model: "another-model"}), JSON.stringify({...state(), reservedCalls: 26}), JSON.stringify({...state(), authorizedCalls: 27}), JSON.stringify({...state(), records: [{slot: 1}]}), JSON.stringify({...state(), authorizationDate: "2026-10-04"}), JSON.stringify({...state(), purpose: "Unrelated session"})]) {
    writeFileSync(journal, value);
    await budgetGateway({journal, id: "G01", kind: "corpus", apiKey: "synthetic-test-key", onDenied: () => denied++, transport: async () => {calls++; throw new Error("must not reach transport");}}).generate(request(), new AbortController().signal);
  }
  assert.equal(calls, 0); assert.equal(denied, 7);
}));
test("model mismatch and failed persistence deny before any inference", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const gateway = budgetGateway({journal, id: "G01", kind: "corpus", apiKey: "synthetic-test-key", transport: async () => {calls++; throw new Error("must not call");}, onDenied: () => denied++});
  await gateway.generate({...request(), model: "another-model"}, new AbortController().signal);
  writeFileSync(`${journal}.lock`, "other process");
  await gateway.generate(request(), new AbortController().signal);
  assert.equal(calls, 0); assert.equal(denied, 2);
}));

test("all validator probes preserve outside behavior and saved positions without treating derived flow versions as edits", () => {
  for (const item of loadCorpus()) {
    const observed = assess(item, item.validationProbe);
    assert.equal(observed.schemaFailure, null, item.id); assert.equal(observed.applicationFailure, null, item.id); assert.equal(observed.scopePreserved, true, item.id);
    assert.equal(observed.humanReview.status, "not_reviewed"); assert.equal(observed.humanReview.useful, null);
  }
});
test("a durable journey slot blocks a worker retry and transports cannot follow redirects", async () => budgetTest(async journal => {
  let calls = 0, denied = 0;
  const gateway = budgetGateway({journal,id:"journey:PROPOSE_FLOW",kind:"journey",apiKey:"synthetic-test-key",transport:async (_input, init) => {calls++; assert.equal(init?.redirect,"error"); return new Response("{}",{status:503});},onDenied:()=>denied++});
  assert.equal((await gateway.generate(request(),new AbortController().signal)).kind,"unavailable");
  assert.equal((await gateway.generate(request(),new AbortController().signal)).kind,"refused");
  assert.equal(calls,1); assert.equal(denied,1);
}));
test("hostile model authority, boundary edits, foreign citations and unresolved dependencies fail canonical assessment", () => {
  const improve = loadCorpus()[12];
  const proposal = (operations: unknown[], citations: unknown[] = []) => ({schemaVersion:1,kind:"proposal",operations,assumptions:[],citations});
  for (const output of [
    {...improve.validationProbe as object, approved:true},
    proposal([{id:"bad",dependsOn:[],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.graph.boundaryNodeIds[0],label:"Hostile boundary edit"}}}]),
    proposal([{id:"bad",dependsOn:["missing"],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.selection!.nodeIds[0],label:"Missing prerequisite"}}}]),
    proposal([{id:"bad",dependsOn:[],edit:{command:"UPDATE_NODE",payload:{nodeId:improve.capture.selection!.nodeIds[0],label:"Foreign citation"}}}],[{sourceVersionId:"00000000-0000-4000-8000-000000999999",startLine:1,endLine:1,excerpt:"Invented"}]),
    {schemaVersion:1,kind:"clarification",message:"Need context",operations:[]},
    "{truncated",
  ]) assert.notEqual(assess(improve,output).schemaFailure,null);
});


test("a failed fsync cannot start transport and its uncertain slot is never reclaimed", async () => budgetTest(async journal => {
  let calls=0, denied=0;
  const gateway=budgetGateway({journal,id:"G01",kind:"corpus",apiKey:"synthetic-test-key",transport:async()=>{calls++;throw new Error("must not start");},syncFile:()=>{throw new Error("injected storage failure");},onDenied:()=>denied++});
  await gateway.generate(request(),new AbortController().signal);
  assert.equal(calls,0);assert.equal(denied,1);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,1);
}));
test("a valid exhausted 26-slot journal denies without a physical call", async () => budgetTest(async journal => {
  const names=["G","I"].flatMap(p=>Array.from({length:12},(_,i)=>`${p}${String(i+1).padStart(2,"0")}`)).concat(["journey:PROPOSE_FLOW","journey:REFINE_FLOW_SELECTION"]);
  writeFileSync(journal,JSON.stringify({...state(),reservedCalls:26,records:names.map((name,i)=>({slot:i+1,id:name,kind:i<24?"corpus":"journey",runId:`00000000-0000-4000-8000-${String(i+100).padStart(12,"0")}`,model:MODEL,reservedAt:"2026-10-05T00:00:00.000Z"}))}));
  let calls=0,denied=0;
  await budgetGateway({journal,id:"G01",kind:"corpus",apiKey:"synthetic-test-key",transport:async()=>{calls++;throw new Error("must not call");},onDenied:()=>denied++}).generate(request(),new AbortController().signal);
  assert.equal(calls,0);assert.equal(denied,1);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,26);
}));

test("hash-consistent forged captures, foreign source ownership and stale identities fail before evaluation", async () => budgetTest(async journal => {
  const corpusFile=join(journal,"..","cases.json");
  const original=JSON.parse(readFileSync(new URL("./evaluation/cases.json",import.meta.url),"utf8"));
  for (const mutate of [
    (raw: typeof original) => {raw.cases[12].capture.graph.nodes[0].readOnly=false;raw.cases[12].capture.graphHash=sha256(canonicalJson(raw.cases[12].capture.graph));raw.cases[12].captureHash=sha256(canonicalJson(raw.cases[12].capture));},
    (raw: typeof original) => {raw.cases[6].saved.sources[0].projectId="00000000-0000-4000-8000-000000999999";},
    (raw: typeof original) => {raw.cases[0].input.expectedDocumentRevision++;},
    (raw: typeof original) => {raw.cases[0].capture.limits.maxInputTokens=1000000;raw.cases[0].captureHash=sha256(canonicalJson(raw.cases[0].capture));},
    (raw: typeof original) => {raw.cases[0].partition="held-out";},
  ]) { const raw=structuredClone(original);mutate(raw);writeFileSync(corpusFile,JSON.stringify(raw));assert.throws(()=>loadCorpus(corpusFile)); }
}));



test("unavailable output never becomes a validation or usefulness success in aggregate counts", () => {
  const item=loadCorpus()[0];
  const counts=outcomeCounts([{outcome:"unavailable",assessment:null},{outcome:"completed",assessment:assess(item,{schemaVersion:1,kind:"clarification",message:"Which authorizer?"})},{outcome:"completed",assessment:assess(item,{schemaVersion:1,kind:"proposal",operations:[]})}]);
  assert.deepEqual(counts,{providerNoncompletion:1,schemaFailures:1,applicationFailures:0,scopePreservationFailures:0,validatedProposals:0,validatedClarifications:1});
});

const renewedState = () => ({wave:"2026-10-06-renewed",purpose:"24 corrected synthetic evaluation cases plus up to six targeted journeys or diagnostics",authorizationDate:"2026-10-06",scope:"No retries, refunds, reclaim or automatic replay",model:MODEL,authorizedCalls:30,priorCalls:26,priorJournalSha256:"ad4371362e02488ba6b7489404ea4cb8d7172eeeac4be2733c408ea0a5dea5c0",cumulativeAuthorizedCalls:56,reservedCalls:0,records:[]});
async function renewedTest(run: (journal: string, baselineJournal: string) => Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),"scoperoom-renewed-evaluation-")); const journal=join(dir,"budget.json"), baselineJournal=join(dir,"original.json");
  writeFileSync(journal,JSON.stringify(renewedState()));
  const names=["G","I"].flatMap(p=>Array.from({length:12},(_,i)=>`${p}${String(i+1).padStart(2,"0")}`)).concat(["journey:PROPOSE_FLOW","journey:REFINE_FLOW_SELECTION"]);
  writeFileSync(baselineJournal,JSON.stringify({...state(),reservedCalls:26,records:names.map((name,i)=>({slot:i+1,id:name,kind:i<24?"corpus":"journey",runId:`00000000-0000-4000-8000-${String(i+100).padStart(12,"0")}`,model:MODEL,reservedAt:"2026-10-05T00:00:00.000Z"}))}));
  try {await run(journal,baselineJournal);} finally {rmSync(dir,{recursive:true,force:true});}
}
const renewedOptions = (journal: string, baselineJournal: string, transport: typeof fetch) => ({journal,baselineJournal,baselineSha256:sha256(readFileSync(baselineJournal,"utf8")),wave:"2026-10-06-renewed" as const,id:"G01",kind:"corpus" as const,apiKey:"synthetic-test-key",transport});
const renewedRequest = (n: number) => ({...request(),runId:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`});
const renewedRecord = (name: string, n: number, kind: "corpus" | "journey") => ({slot:n,id:name,kind,runId:renewedRequest(n+200).runId,model:MODEL,reservedAt:"2026-10-06T00:00:00.000Z"});
test("renewed authority fsyncs a separate call before transport, preserves original bytes and denies replay",async()=>renewedTest(async(journal,baselineJournal)=>{
  const before=readFileSync(baselineJournal); let calls=0,synced=false;const observations:unknown[]=[];
  const options={...renewedOptions(journal,baselineJournal,async(_input,init)=>{calls++;const saved=JSON.parse(readFileSync(journal,"utf8"));observations.push({synced,redirect:init?.redirect,reservedCalls:saved.reservedCalls,runId:saved.records[0].runId});throw Error("uncertain response");}),syncFile:(fd:number)=>{fsyncSync(fd);synced=true;}};
  await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);
  await budgetGateway(options).generate(renewedRequest(902),new AbortController().signal);
  assert.equal(calls,1);assert.deepEqual(observations,[{synced:true,redirect:"error",reservedCalls:1,runId:"00000000-0000-4000-8000-000000000901"}]);assert.deepEqual(readFileSync(baselineJournal),before);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,1);
}));
test("renewed wave must be explicit and cannot be selected by deterministic arguments",()=>{
  assert.deepEqual(selectCases(["--live","--synthetic",`--model=${MODEL}`,"--target=synthetic","--wave=2026-10-06-renewed","--only=G01","--limit=1"]),["G01"]);
  for(const args of [["--wave=2026-10-06-renewed"],["--live","--wave=other"],["--wave=2026-10-06-renewed","--only=G01"]]) assert.throws(()=>selectCases(args));
});
test("renewed authority rejects malformed journals, baseline changes and authority mismatches before transport",async()=>renewedTest(async(journal,baselineJournal)=>{
  let calls=0,denied=0; const options={...renewedOptions(journal,baselineJournal,async()=>{calls++;throw Error("must not call");}),onDenied:()=>denied++};
  const original=readFileSync(baselineJournal);
  const mutations=["{",JSON.stringify({...renewedState(),wave:"another-wave"}),JSON.stringify({...renewedState(),model:"another-model"}),JSON.stringify({...renewedState(),authorizedCalls:31}),JSON.stringify({...renewedState(),priorCalls:25}),JSON.stringify({...renewedState(),cumulativeAuthorizedCalls:57}),JSON.stringify({...renewedState(),priorJournalSha256:"0".repeat(64)}),JSON.stringify({...renewedState(),reservedCalls:1}),JSON.stringify({...renewedState(),records:[{slot:1}]}),JSON.stringify({...renewedState(),scope:"Refund permitted"}),JSON.stringify({...renewedState(),authorizationDate:"2026-10-05"}),JSON.stringify({...renewedState(),unexpected:true})];
  for(const value of mutations){writeFileSync(journal,value);await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);}
  writeFileSync(journal,JSON.stringify(renewedState()));
  for(const baseline of ["{",JSON.stringify(state()),`${original.toString("utf8")} `]){writeFileSync(baselineJournal,baseline);await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);}
  assert.equal(calls,0);assert.equal(denied,15);
}));
test("renewed corpus and targeted caps allow the thirtieth call and refuse the thirty-first",async()=>renewedTest(async(journal,baselineJournal)=>{
  const names=["G","I"].flatMap(p=>Array.from({length:12},(_,i)=>`${p}${String(i+1).padStart(2,"0")}`));
  const records=names.map((name,i)=>renewedRecord(name,i+1,"corpus"));
  for(let n=25;n<=29;n++)records.push(renewedRecord(`journey:${renewedRequest(n+200).runId}`,n,"journey"));
  writeFileSync(journal,JSON.stringify({...renewedState(),reservedCalls:29,records})); let calls=0;
  const invoke=(n:number)=>budgetGateway({...renewedOptions(journal,baselineJournal,async()=>{calls++;throw Error("uncertain response");}),id:`journey:${renewedRequest(n).runId}`,kind:"journey"}).generate(renewedRequest(n),new AbortController().signal);
  await invoke(901);await invoke(902); assert.equal(calls,1); assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,30);
}));
test("renewed authority enforces six targeted calls independently of available corpus capacity",async()=>renewedTest(async(journal,baselineJournal)=>{
  const records=Array.from({length:6},(_,i)=>renewedRecord(`journey:${renewedRequest(i+201).runId}`,i+1,"journey"));
  writeFileSync(journal,JSON.stringify({...renewedState(),reservedCalls:6,records}));let calls=0;
  const transport:typeof fetch=async()=>{calls++;throw Error("uncertain response");};
  await budgetGateway({...renewedOptions(journal,baselineJournal,transport),id:`journey:${renewedRequest(901).runId}`,kind:"journey"}).generate(renewedRequest(901),new AbortController().signal);
  assert.equal(calls,0);
  await budgetGateway(renewedOptions(journal,baselineJournal,transport)).generate(renewedRequest(902),new AbortController().signal);
  assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,7);
}));
test("renewed duplicate ids, run ids, original run reuse and mismatched targeted ids deny",async()=>renewedTest(async(journal,baselineJournal)=>{
  const record=renewedRecord("G01",1,"corpus");let calls=0;const options=renewedOptions(journal,baselineJournal,async()=>{calls++;throw Error("must not call");});
  for(const [first,second] of [[record,{...record,slot:2}], [record,{...record,slot:2,id:"G02"}],[record,{...record,slot:2,id:"journey:bad",kind:"journey"}]]){
    writeFileSync(journal,JSON.stringify({...renewedState(),reservedCalls:2,records:[first,second]}));await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);
  }
  writeFileSync(journal,JSON.stringify(renewedState()));
  const old=JSON.parse(readFileSync(baselineJournal,"utf8"));
  await budgetGateway(options).generate({...request(),runId:old.records[0].runId},new AbortController().signal);
  await budgetGateway({...options,id:`journey:${renewedRequest(902).runId}`,kind:"journey"}).generate(renewedRequest(901),new AbortController().signal);
  assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,0);
}));
test("renewed locked or uncertain persistence never reaches transport or reclaims a call",async()=>renewedTest(async(journal,baselineJournal)=>{
  let calls=0;const options=renewedOptions(journal,baselineJournal,async()=>{calls++;throw Error("must not call");});
  writeFileSync(`${journal}.lock`,"other process");await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,0);rmSync(`${journal}.lock`);
  await budgetGateway({...options,syncFile:()=>{throw Error("injected fsync failure");}}).generate(renewedRequest(901),new AbortController().signal);
  assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,1);
  await budgetGateway(options).generate(renewedRequest(902),new AbortController().signal);assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,1);
}));

test("renewed normal guard rejects a synthetic baseline without a test hash override",async()=>renewedTest(async(journal,baselineJournal)=>{
  let calls=0;const {baselineSha256,...options}=renewedOptions(journal,baselineJournal,async()=>{calls++;throw Error("must not call");});void baselineSha256;
  await budgetGateway(options).generate(renewedRequest(901),new AbortController().signal);assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(journal,"utf8")).reservedCalls,0);
}));
