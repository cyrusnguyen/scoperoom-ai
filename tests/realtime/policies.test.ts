import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { parseTopic } from "../../src/features/collaboration/contracts/topics.ts";
import { archiveProject, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import type { Identity } from "../integration/support/fixture.ts";
import { controlSend, policyAllows, RECEIVE_TIMEOUT_MS, SILENCE_MS, withRealtimeFixture, type Realtime } from "./support.ts";

// Real Auth sessions over real sockets against the installed provider policies. Every socket result is paired with the application's own
// membership facts (getProjectStatus) and the database policy decision, so an outage cannot masquerade as a denial.
const DENIED = /Unauthorized|permissions/i; // the provider refuses unauthorised private joins with an explicit message
const ROLES = ["OWNER", "EDITOR", "REVIEWER", "VIEWER"] as const;

async function topicsFor(owner: Identity, projectId: string) {
  return (await getProjectBootstrap(owner, projectId)).realtime;
}

/** Reads the actual membership role through the application service; a non-member must be refused. */
async function roleOf(who: Identity, projectId: string) {
  return getProjectStatus(who, projectId).then((status) => status.role, () => null);
}

/** Sends from `sender` and reports the ack plus which of `listeners` received it inside the bounded window. */
async function broadcast(rt: Realtime, sender: Parameters<Realtime["send"]>[0], listeners: Parameters<Realtime["receive"]>[0][], expectDelivery: boolean) {
  const event = `m-${randomUUID()}`;
  const seen = listeners.map((channel) => rt.receive(channel, event, expectDelivery ? RECEIVE_TIMEOUT_MS : SILENCE_MS).then(() => true, () => false)); // observers exist before the send
  const status = await rt.send(sender, event, { n: 1 });
  return { status, delivered: await Promise.all(seen) };
}

test("both topics enforce exact role capabilities over real sockets", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor, reviewer, viewer, removed, stranger] = await Promise.all(["Owner", "Editor", "Reviewer", "Viewer", "Removed", "Stranger"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    await fixture.join(owner!, projectId, reviewer!, "REVIEWER");
    await fixture.join(owner!, projectId, viewer!, "VIEWER");
    await fixture.join(owner!, projectId, removed!, "EDITOR");
    const { rows: [member] } = await fixture.database.query<{ id: string; version: number }>("select m.profile_id as id, m.version from app.project_membership m join app.user_profile p on p.id = m.profile_id where p.auth_user_id = $1 and m.project_id = $2", [removed!.authUserId, projectId]);
    await removeProjectMember(owner!, projectId, member!.id, { expectedMemberVersion: member!.version, key: randomUUID() }); // rotates the epoch: topics are read afterwards
    const topics = await topicsFor(owner!, projectId);
    const { realtimeEpoch } = await getProjectStatus(owner!, projectId);
    assert.deepEqual(topics, { events: `project:${projectId}:${realtimeEpoch}:events`, collab: `project:${projectId}:${realtimeEpoch}:collab` });

    // Membership facts from the application: roles as invited, removed member and stranger refused.
    const members = { OWNER: owner!, EDITOR: editor!, REVIEWER: reviewer!, VIEWER: viewer! };
    for (const role of ROLES) assert.equal(await roleOf(members[role], projectId), role);
    assert.equal(await roleOf(removed!, projectId), null);
    assert.equal(await roleOf(stranger!, projectId), null);

    // Non-members cannot join either topic, and the database policy agrees.
    await Promise.all([removed!, stranger!].flatMap((outsider) => [topics.events, topics.collab].map(async (topic) => {
      assert.equal(await policyAllows(fixture.database, outsider.authUserId, topic, "receive_broadcast"), false);
      await assert.rejects(rt.join(await rt.client(outsider), topic), DENIED);
    })));
    await assert.rejects(rt.join(await rt.client(), topics.collab), DENIED, "anonymous browsers cannot join");

    // Every member joins both topics (join is read access only).
    const sockets = {} as Record<(typeof ROLES)[number], { events: Awaited<ReturnType<Realtime["join"]>>; collab: Awaited<ReturnType<Realtime["join"]>> }>;
    for (const role of ROLES) {
      const client = await rt.client(members[role]);
      sockets[role] = { events: await rt.join(client, topics.events), collab: await rt.join(client, topics.collab) };
      for (const [topic, capability] of [[topics.events, "receive_broadcast"], [topics.collab, "receive_broadcast"], [topics.collab, "presence"]] as const) {
        assert.equal(await policyAllows(fixture.database, members[role].authUserId, topic, capability), true, `${role} ${capability}`);
      }
    }

    // Collab Broadcast: only owner and editor may send. Reviewer/viewer sends are neither acknowledged nor delivered.
    await Promise.all(ROLES.map(async (role) => {
      const mayWrite = role === "OWNER" || role === "EDITOR";
      assert.equal(await policyAllows(fixture.database, members[role].authUserId, topics.collab, "send_broadcast"), mayWrite, `${role} policy`);
      const result = await broadcast(rt, sockets[role].collab, ROLES.filter((other) => other !== role).map((other) => sockets[other].collab), mayWrite);
      if (mayWrite) assert.deepEqual([result.status, ...result.delivered], ["ok", true, true, true], `${role} collab send`);
      else assert.deepEqual([result.status === "ok", ...result.delivered], [false, false, false, false], `${role} collab send`);
    }));

    // Events: no browser may send, but members do receive database-originated hints (positive control for the silence below).
    const event = `control-${randomUUID()}`;
    const controls = ROLES.map((role) => rt.receive(sockets[role].events, event));
    await controlSend(fixture.database, topics.events, event);
    await Promise.all(controls);
    await Promise.all(ROLES.map(async (role) => {
      assert.equal(await policyAllows(fixture.database, members[role].authUserId, topics.events, "send_broadcast"), false, `${role} events policy`);
      const result = await broadcast(rt, sockets[role].events, ROLES.filter((other) => other !== role).map((other) => sockets[other].events), false);
      assert.deepEqual([result.status === "ok", ...result.delivered], [false, false, false, false], `${role} events send`);
    }));

    // Presence on collab: every member (reviewer and viewer included) may track and is seen by others; events Presence is refused.
    for (const role of ROLES) {
      assert.equal(await policyAllows(fixture.database, members[role].authUserId, topics.collab, "presence"), true);
      const seen = rt.receivePresence(sockets[ROLES.find((other) => other !== role)!].collab, "join");
      assert.equal(await rt.track(sockets[role].collab, { role }), "ok", `${role} presence`);
      await seen;
    }
    assert.equal(await policyAllows(fixture.database, owner!.authUserId, topics.events, "presence"), false);
    const unseen = rt.receivePresence(sockets.EDITOR.events, "join", SILENCE_MS).then(() => true, () => false);
    await rt.track(sockets.OWNER.events, { role: "OWNER" });
    assert.equal(await unseen, false, "events channel carries no Presence");
  });
});

test("forged role metadata, malformed topics, stale epochs and public channels grant nothing", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, viewer, stranger] = await Promise.all(["Owner", "Viewer", "Stranger"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, viewer!, "VIEWER");
    const topics = await topicsFor(owner!, projectId);
    const epoch = parseTopic(topics.collab)!.epoch;

    // Real Auth sessions whose token carries claims that pretend to be a higher project role (set through Auth admin, never a forged JWT).
    const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
    for (const who of [viewer!, stranger!]) {
      const { error } = await admin.auth.admin.updateUserById(who.authUserId, { user_metadata: { role: "OWNER", project_role: "OWNER", projectId }, app_metadata: { role: "OWNER", project_role: "OWNER", projects: { [projectId]: "OWNER" } } });
      assert.equal(error, null);
    }
    const viewerClient = await rt.client(viewer!);
    const claims = JSON.parse(Buffer.from((await viewerClient.auth.getSession()).data.session!.access_token.split(".")[1]!, "base64url").toString());
    assert.equal(claims.user_metadata.project_role, "OWNER", "the real token carries the forged claim");
    assert.equal(claims.role, "authenticated");
    assert.equal(await roleOf(viewer!, projectId), "VIEWER");
    assert.equal(await roleOf(stranger!, projectId), null);
    const forged = { user_metadata: { role: "OWNER", project_role: "OWNER" }, app_metadata: { role: "OWNER", project_role: "OWNER" } };
    assert.equal(await policyAllows(fixture.database, viewer!.authUserId, topics.collab, "send_broadcast", forged), false);
    assert.equal(await policyAllows(fixture.database, stranger!.authUserId, topics.collab, "receive_broadcast", forged), false);

    const ownerCollab = await rt.join(await rt.client(owner!), topics.collab);
    const viewerCollab = await rt.join(viewerClient, topics.collab);
    const forgedSend = await broadcast(rt, viewerCollab, [ownerCollab], false);
    assert.deepEqual([forgedSend.status === "ok", ...forgedSend.delivered], [false, false], "a forged owner claim does not enable sending");
    const control = await broadcast(rt, ownerCollab, [viewerCollab], true); // the channel itself works, so the silence above is denial
    assert.deepEqual([control.status, ...control.delivered], ["ok", true]);
    await assert.rejects(rt.join(await rt.client(stranger!), topics.collab), DENIED);

    // Malformed, cross-project and stale-epoch names never authorize, and the client contract parser rejects them too.
    const staleEpoch = randomUUID();
    const otherProject = randomUUID();
    const malformed = ["project:garbage", topics.collab.toUpperCase(), `${topics.collab}:extra`, `project:${projectId}:${epoch}:other`, "project:not-a-uuid:not-a-uuid:events"];
    const wrongButWellFormed = [`project:${epoch}:${projectId}:collab`, `project:${projectId}:${staleEpoch}:collab`, `project:${otherProject}:${epoch}:collab`]; // parse fine; only the database refuses them
    await Promise.all([...malformed, ...wrongButWellFormed].map(async (topic) => {
      assert.equal(parseTopic(topic) === null, malformed.includes(topic), topic);
      assert.equal(await policyAllows(fixture.database, owner!.authUserId, topic, "receive_broadcast"), false, topic);
      await assert.rejects(rt.join(await rt.client(owner!), topic), DENIED, topic);
    }));

    // The owner can join a private channel, but the same topic as a public channel is refused by the private-only tenant.
    await assert.rejects(rt.join(await rt.client(owner!), topics.collab, { private: false }), /private/i);
  });
});

test("archived projects stay readable without Broadcast, deleting projects are denied, and rotation retires old topics", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor] = await Promise.all(["Owner", "Editor"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    const before = await topicsFor(owner!, projectId);
    const status = await getProjectStatus(owner!, projectId);
    await archiveProject(owner!, projectId, { expectedProjectVersion: status.version, reason: "Wrapped up", key: randomUUID() }); // rotates the epoch
    assert.equal((await getProjectStatus(owner!, projectId)).status, "ARCHIVED");
    const after = await topicsFor(owner!, projectId);
    assert.notEqual(after.collab, before.collab);

    // The retired epoch is unusable for everyone, while the current one is readable.
    assert.equal(await policyAllows(fixture.database, owner!.authUserId, before.collab, "receive_broadcast"), false);
    await assert.rejects(rt.join(await rt.client(owner!), before.collab), DENIED);
    const ownerCollab = await rt.join(await rt.client(owner!), after.collab);
    const editorCollab = await rt.join(await rt.client(editor!), after.collab);
    const editorEvents = await rt.join(await rt.client(editor!), after.events);

    // Archived: read and Presence work, Broadcast sends are refused for the owner and the editor alike.
    for (const who of [owner!, editor!]) {
      assert.equal(await policyAllows(fixture.database, who.authUserId, after.collab, "send_broadcast"), false);
      assert.equal(await policyAllows(fixture.database, who.authUserId, after.collab, "presence"), true);
    }
    const event = `control-${randomUUID()}`;
    const controls = [rt.receive(ownerCollab, event), rt.receive(editorCollab, event), rt.receive(editorEvents, event)];
    await controlSend(fixture.database, after.collab, event);
    await controlSend(fixture.database, after.events, event);
    await Promise.all(controls); // reads still work
    for (const [sender, listener] of [[ownerCollab, editorCollab], [editorCollab, ownerCollab]] as const) {
      const result = await broadcast(rt, sender, [listener], false);
      assert.deepEqual([result.status === "ok", ...result.delivered], [false, false]);
    }
    const seen = rt.receivePresence(ownerCollab, "join");
    assert.equal(await rt.track(editorCollab, { archived: true }), "ok");
    await seen;

    // Deleting projects disappear from the application and are denied by policy to every member.
    await fixture.database.query("update app.project set status = 'DELETING' where id = $1", [projectId]);
    await Promise.all([owner!, editor!].flatMap((who) => [after.events, after.collab].map(async (topic) => {
      assert.equal(await roleOf(who, projectId), null);
      assert.equal(await policyAllows(fixture.database, who.authUserId, topic, "receive_broadcast"), false);
      await assert.rejects(rt.join(await rt.client(who), topic), DENIED);
    })));
  });
});
