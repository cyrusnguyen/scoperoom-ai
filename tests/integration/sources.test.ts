import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
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
    await assert.rejects(createGraphSource(owner, projectId, draftId, { key: key(), expectedDocumentRevision: 1, flowId, title: "Checkout flow" }), refused("STALE_DOCUMENT_REVISION"));
    const body = { key: key(), expectedDocumentRevision: flow.documentRevision, flowId, title: "Checkout flow" };
    const source = await createGraphSource(owner, projectId, draftId, body);
    const version = await readSourceVersion(owner, projectId, source.sourceVersionId);
    assert.equal(version.kind, "PROMOTED_GRAPH");
    assert.match(version.text, /^Flow: Checkout\n/);
    assert.deepEqual(version.origin, { type: "GRAPH", draftId, documentRevision: flow.documentRevision, flowId, copiedTextHash: version.contentHash, promotedBy: version.createdBy });
    assert.equal((await getDraft(owner, projectId, draftId)).documentRevision, flow.documentRevision, "the draft is not changed");
    const { rows } = await database.query("select count(*)::int n from app.source_document where project_id = $1 and kind = 'PROMOTED_GRAPH'", [projectId]);
    assert.equal(rows[0].n, 1);
    // Ids are case-insensitive on the wire: the same write with uppercase ids replays instead of failing.
    assert.deepEqual(await createGraphSource(owner, projectId.toUpperCase(), draftId.toUpperCase(), body), { ...source, replayed: true });
  });
});
