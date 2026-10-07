import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { readSourceVersion } from "../../src/features/sources/server/source-versions.ts";
import { correctSource, createGraphSource, createSource, listSources, listSourceVersions, updateSource } from "../../src/features/sources/server/sources.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const refused = (code: string) => (error: unknown) => error instanceof ProjectError && error.code === code;
const key = () => `src-${randomUUID()}`;

test("paste, correct and archive keep every immutable version", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("source owner");
    const projectId = await project(owner);
    const created = await createSource(owner, projectId, { key: key(), title: "Brief", text: "\uFEFFone\r\ntwo" });
    assert.equal(created.replayed, false);
    const first = await readSourceVersion(owner, projectId, created.sourceVersionId);
    assert.equal(first.text, "one\ntwo");
    assert.equal((await getProjectStatus(owner, projectId)).sourcesRevision, created.sourcesRevision);

    const corrected = await correctSource(owner, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: created.sourceVersionId, title: "Brief v2", text: "one\nthree" });
    assert.equal(corrected.sequence, 2);
    assert.equal((await readSourceVersion(owner, projectId, created.sourceVersionId)).title, "Brief", "old version keeps its title");
    await assert.rejects(correctSource(owner, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: created.sourceVersionId, title: "Late", text: "x" }), refused("STALE_ENTITY_VERSION"));

    const versions = await listSourceVersions(owner, projectId, created.sourceId);
    assert.deepEqual(versions.items.map((item) => item.sequence), [2, 1]);

    await updateSource(owner, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 2, archived: true });
    assert.equal((await listSources(owner, projectId, {})).items.length, 0);
    assert.equal((await listSources(owner, projectId, { scope: "archived" })).items[0]?.title, "Brief v2");
    assert.equal((await readSourceVersion(owner, projectId, created.sourceVersionId)).text, "one\ntwo", "archived evidence stays readable");
  });
});

test("paste and upload normalize identically; a second leading BOM is refused", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("bom owner");
    const projectId = await project(owner);
    // The browser decodes uploads with ignoreBOM: true, so an upload reaches the server with its BOM, exactly like a paste.
    const pasted = await createSource(owner, projectId, { key: key(), title: "Pasted", text: "\uFEFFa\r\nb\rc" });
    const uploaded = await createSource(owner, projectId, { key: key(), title: "Uploaded", text: "\uFEFFa\r\nb\rc", uploaded: true });
    const [left, right] = [await readSourceVersion(owner, projectId, pasted.sourceVersionId), await readSourceVersion(owner, projectId, uploaded.sourceVersionId)];
    assert.deepEqual([left.text, left.contentHash, left.lineStarts], [right.text, right.contentHash, right.lineStarts]);
    assert.deepEqual([left.kind, right.kind], ["USER_TEXT", "USER_UPLOAD"]);
    await assert.rejects(createSource(owner, projectId, { key: key(), title: "Two BOMs", text: "\uFEFF\uFEFFa" }), refused("INVALID_INPUT"));
  });
});

test("receipts replay; viewers and other projects are refused", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("source owner"), viewer = await user("source viewer"), stranger = await user("stranger");
    const projectId = await project(owner);
    await join(owner, projectId, viewer, "VIEWER");
    const same = key();
    const created = await createSource(owner, projectId, { key: same, title: "Brief", text: "a" });
    assert.equal((await createSource(owner, projectId, { key: same, title: "Brief", text: "a" })).replayed, true);
    await assert.rejects(createSource(owner, projectId, { key: same, title: "Other", text: "a" }), refused("KEY_REUSED"));
    await assert.rejects(createSource(viewer, projectId, { key: key(), title: "Brief", text: "a" }), refused("FORBIDDEN"));
    assert.equal((await listSources(viewer, projectId, {})).items.length, 1, "readers list sources");
    const otherProject = await project(stranger);
    await assert.rejects(readSourceVersion(stranger, otherProject, created.sourceVersionId), refused("NOT_FOUND"));
    await assert.rejects(listSourceVersions(stranger, otherProject, created.sourceId), refused("NOT_FOUND"));
  });
});

test("caps refuse the whole write and keep existing evidence", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("cap owner");
    const projectId = await project(owner);
    await assert.rejects(createSource(owner, projectId, { key: key(), title: "Big", text: "x".repeat(50_001) }), refused("LIMIT_EXCEEDED"));
    for (let index = 0; index < 30; index++) await createSource(owner, projectId, { key: key(), title: `Doc ${index}`, text: "a" });
    await assert.rejects(createSource(owner, projectId, { key: key(), title: "Thirty-first", text: "a" }), refused("LIMIT_EXCEEDED"));
    const { rows: [usage] } = await database.query("select count(*)::int n from app.source_document where project_id = $1", [projectId]);
    assert.equal(usage.n, 30);
    const page = await listSources(owner, projectId, {});
    assert.equal(page.usage.activeUserDocuments, 30);
    assert.equal(page.items.length, 30);

    // Restoring needs a free slot: archive one, fill the slot again, and the refused restore writes nothing.
    const [victim] = page.items;
    await updateSource(owner, projectId, victim!.id, { key: key(), expectedSourceRecordVersion: victim!.version, archived: true });
    await createSource(owner, projectId, { key: key(), title: "Replacement", text: "a" });
    const counts = () => database.query(
      "select (select count(*)::int from app.audit_event where project_id = $1) events, (select count(*)::int from app.mutation_receipt where scope_id = $1) receipts, (select version from app.source_document where id = $2) version",
      [projectId, victim!.id],
    ).then((result) => result.rows[0]);
    const before = await counts();
    await assert.rejects(updateSource(owner, projectId, victim!.id, { key: key(), expectedSourceRecordVersion: victim!.version + 1, archived: false }), refused("LIMIT_EXCEEDED"));
    assert.deepEqual(await counts(), before);
    assert.equal((await listSources(owner, projectId, {})).usage.activeUserDocuments, 30);
  });
});

test("ids are case-insensitive: an uppercase source id replays its receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("case owner");
    const projectId = await project(owner);
    const created = await createSource(owner, projectId, { key: key(), title: "Brief", text: "a" });
    const body = { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: created.sourceVersionId, title: "Brief v2", text: "b" };
    const first = await correctSource(owner, projectId.toUpperCase(), created.sourceId.toUpperCase(), body);
    assert.equal(first.sourceId, created.sourceId);
    assert.deepEqual(await correctSource(owner, projectId, created.sourceId, body), { ...first, replayed: true });
    const rename = { key: key(), expectedSourceRecordVersion: 2, displayNickname: "Nick" };
    const renamed = await updateSource(owner, projectId, created.sourceId.toUpperCase(), rename);
    assert.deepEqual(await updateSource(owner, projectId, created.sourceId, rename), { ...renamed, replayed: true });
  });
});

test("viewers and reviewers cannot correct or update; archived sources cannot be corrected", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("role owner"), viewer = await user("role viewer"), reviewer = await user("role reviewer");
    const projectId = await project(owner);
    await join(owner, projectId, viewer, "VIEWER");
    await join(owner, projectId, reviewer, "REVIEWER");
    const created = await createSource(owner, projectId, { key: key(), title: "Brief", text: "a" });
    const correction = () => ({ key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: created.sourceVersionId, title: "T", text: "b" });
    for (const member of [viewer, reviewer]) {
      await assert.rejects(correctSource(member, projectId, created.sourceId, correction()), refused("FORBIDDEN"));
      await assert.rejects(updateSource(member, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 1, archived: true }), refused("FORBIDDEN"));
    }
    const archived = await updateSource(owner, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 1, archived: true });
    await assert.rejects(correctSource(owner, projectId, created.sourceId, { ...correction(), expectedSourceRecordVersion: archived.version }), refused("CONFLICT"));
  });
});

test("internal evidence is read-only: no correction, archive or rename", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database, profileId }) => {
    const owner = await user("prompt owner");
    const projectId = await project(owner);
    const actorId = await profileId(owner);
    const sourceId = randomUUID(), versionId = randomUUID();
    await database.query("begin");
    await database.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'AI_PROMPT', $3, $4)", [sourceId, projectId, versionId, actorId]);
    await database.query(
      "insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by) values ($1, $2, $3, 1, 'AI instruction', 'ask', 3, 3, encode(sha256(convert_to('ask', 'UTF8')), 'hex'), $4)",
      [versionId, projectId, sourceId, actorId],
    );
    await database.query("commit");
    const row = () => database.query("select version, archived, display_nickname, current_version_id from app.source_document where id = $1", [sourceId]).then((result) => result.rows[0]);
    const before = await row();
    await assert.rejects(correctSource(owner, projectId, sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: versionId, title: "T", text: "b" }), refused("FORBIDDEN"));
    await assert.rejects(updateSource(owner, projectId, sourceId, { key: key(), expectedSourceRecordVersion: 1, archived: true }), refused("FORBIDDEN"));
    await assert.rejects(updateSource(owner, projectId, sourceId, { key: key(), expectedSourceRecordVersion: 1, displayNickname: "x" }), refused("FORBIDDEN"));
    assert.deepEqual(await row(), before);
  });
});

test("a saved flow becomes attributed PROMOTED_GRAPH evidence bound to its revision", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("graph owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const flow = await executeGraphCommand(owner, projectId, draftId, { key: key(), commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = flow.createdIds[0]!;
    const addStep = (expectedDocumentRevision: number) => executeGraphCommand(owner, projectId, draftId, { key: key(), commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision, payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
    const first = await addStep(flow.documentRevision);
    const twin = await addStep(first.documentRevision); // same label: only the stored ids tell the two steps apart
    await assert.rejects(createGraphSource(owner, projectId, draftId, { key: key(), expectedDocumentRevision: 1, flowId, title: "Checkout flow" }), refused("STALE_DOCUMENT_REVISION"));
    const body = { key: key(), expectedDocumentRevision: twin.documentRevision, flowId, title: "Checkout flow" };
    const source = await createGraphSource(owner, projectId, draftId, body);
    const version = await readSourceVersion(owner, projectId, source.sourceVersionId);
    assert.equal(version.kind, "PROMOTED_GRAPH");
    assert.match(version.text, /^Flow: Checkout\n/);
    const nodeIds = [first.createdIds[0]!, twin.createdIds[0]!].sort();
    assert.deepEqual(version.origin, { type: "GRAPH", draftId, documentRevision: twin.documentRevision, flowId, nodeIds, edgeIds: [], copiedTextHash: version.contentHash, promotedBy: version.createdBy });
    assert.equal((await getDraft(owner, projectId, draftId)).documentRevision, twin.documentRevision, "the draft is not changed");
    // Ids are case-insensitive on the wire: the same write with uppercase ids replays instead of failing.
    assert.deepEqual(await createGraphSource(owner, projectId.toUpperCase(), draftId.toUpperCase(), body), { ...source, replayed: true });

    // Later edits never touch the stored evidence or its provenance.
    await executeGraphCommand(owner, projectId, draftId, { key: key(), commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Pay now" } });
    assert.deepEqual(await readSourceVersion(owner, projectId, source.sourceVersionId), version);

    // The database binds the origin to the version's own hash and author and to its exact shape.
    const copyWith = (originSql: string, draftSql = "origin_draft_id") => database.query(`insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by, origin, origin_draft_id)
      select gen_random_uuid(), project_id, source_id, 2, title, text, code_point_count, utf8_byte_count, content_hash, created_by, ${originSql}, ${draftSql}
      from app.source_version where id = $1`, [source.sourceVersionId]);
    for (const [originSql, draftSql, why] of [
      [`jsonb_set(origin, '{promotedBy}', to_jsonb(gen_random_uuid()::text))`, undefined, "wrong promoter"],
      [`origin - 'promotedBy'`, undefined, "missing promoter"],
      [`origin - 'copiedTextHash'`, undefined, "missing hash"],
      [`origin - 'nodeIds'`, undefined, "missing selected ids"],
      [`jsonb_set(origin, '{nodeIds}', '"all"')`, undefined, "ids not an array"],
      [`origin || '{"note": "x"}'`, undefined, "unknown key"],
      [`origin`, "null", "origin without its draft FK"],
      [`null`, "origin_draft_id", "draft FK without an origin"],
    ] as const) await assert.rejects(copyWith(originSql, draftSql), /source_version_origin_binding/, why);
    const { rows } = await database.query("select count(*)::int n from app.source_document where project_id = $1 and kind = 'PROMOTED_GRAPH'", [projectId]);
    assert.equal(rows[0].n, 1);
  });
});

test("another project's source id is NOT_FOUND for correct and update, and writes change nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("scope owner");
    const own = await project(owner), other = await project(owner);
    const foreign = await createSource(owner, other, { key: key(), title: "Foreign", text: "a" });
    const counts = () => database.query(
      "select (select count(*)::int from app.source_document where project_id = any($1)) documents, (select count(*)::int from app.source_version where project_id = any($1)) versions, (select count(*)::int from app.audit_event where project_id = any($1)) events, (select count(*)::int from app.mutation_receipt where scope_id = any($1)) receipts, (select version from app.source_document where id = $2) version",
      [[own, other], foreign.sourceId],
    ).then((result) => result.rows[0]);
    const before = await counts();
    await assert.rejects(correctSource(owner, own, foreign.sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: foreign.sourceVersionId, title: "T", text: "b" }), refused("NOT_FOUND"));
    await assert.rejects(updateSource(owner, own, foreign.sourceId, { key: key(), expectedSourceRecordVersion: 1, archived: true }), refused("NOT_FOUND"));
    assert.deepEqual(await counts(), before);
  });
});

test("an archived project refuses new, corrected and flow sources and writes nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("archived owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const flow = await executeGraphCommand(owner, projectId, draftId, { key: key(), commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const created = await createSource(owner, projectId, { key: key(), title: "Brief", text: "a" });
    await archiveProject(owner, projectId, { expectedProjectVersion: (await getProjectStatus(owner, projectId)).version, reason: "Done", key: key() });
    const counts = () => database.query(
      "select (select count(*)::int from app.source_document where project_id = $1) documents, (select count(*)::int from app.source_version where project_id = $1) versions, (select count(*)::int from app.mutation_receipt where scope_id = $1) receipts",
      [projectId],
    ).then((result) => result.rows[0]);
    const before = await counts();
    await assert.rejects(createSource(owner, projectId, { key: key(), title: "Late", text: "a" }), refused("CONFLICT"));
    await assert.rejects(correctSource(owner, projectId, created.sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: created.sourceVersionId, title: "T", text: "b" }), refused("CONFLICT"));
    await assert.rejects(createGraphSource(owner, projectId, draftId, { key: key(), expectedDocumentRevision: flow.documentRevision, flowId: flow.createdIds[0]!, title: "Checkout flow" }), refused("CONFLICT"));
    assert.deepEqual(await counts(), before);
    assert.equal((await listSources(owner, projectId, {})).items.length, 1, "the archived project's sources stay readable");
  });
});
