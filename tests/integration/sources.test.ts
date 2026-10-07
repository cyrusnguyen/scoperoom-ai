import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { readSourceVersion } from "../../src/features/sources/server/source-versions.ts";
import { correctSource, createSource, listSources, listSourceVersions, updateSource } from "../../src/features/sources/server/sources.ts";
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
  });
});
