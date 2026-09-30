import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { parseHint } from "../../src/features/collaboration/contracts/messages.ts";
import { issueRealtimeToken } from "../../src/features/collaboration/server/realtime-token.ts";
import type { RealtimeScope } from "../../src/features/collaboration/server/sign-token.ts";
import { saveChanges } from "../../src/features/drafts/server/changes.ts";
import { getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject, changeProjectMember, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import type { Fixture, Identity } from "../integration/support/fixture.ts";
import { draftOf, flowBatch, saveFlow } from "../integration/support/hints.ts";
import { broadcast, clientWithToken, controlSend, mintScoped, RECEIVE_TIMEOUT_MS, withRealtimeFixture, type Realtime } from "./support.ts";

// Revocation, downgrade and archive with real scoped credentials (E36) over real sockets. The provider's own limits are recorded, not
// assumed: Realtime does not re-check a joined socket when membership changes, so the bound is the credential's expiry. Every silence
// is paired with a delivery on the same topic, and every socket fact with the application's own answer.
const DENIED = /Unauthorized|permissions/i;
const CREDENTIAL_S = 300;
const SHORT_LIFE_S = 20; // a back-dated credential with this many seconds left, so expiry can be observed inside a test
const HEARTBEAT_MS = 25_000; // realtime-js default: the longest an idle socket goes without traffic

const isProjectError = (error: unknown) => error instanceof ProjectError;
const scopeOf = async (fixture: Fixture, who: Identity, projectId: string, epoch: string): Promise<RealtimeScope> => ({ profileId: await fixture.profileId(who), projectId, epoch });
const shortLived = () => Date.now() - (CREDENTIAL_S - SHORT_LIFE_S) * 1000;
const topicsOf = async (owner: Identity, projectId: string) => (await getProjectBootstrap(owner, projectId)).realtime;

async function memberOf(fixture: Fixture, who: Identity, projectId: string) {
  const { rows: [member] } = await fixture.database.query<{ id: string; version: number }>("select m.profile_id as id, m.version from app.project_membership m join app.user_profile p on p.id = m.profile_id where p.auth_user_id = $1 and m.project_id = $2", [who.authUserId, projectId]);
  return member!;
}

/** Both channels of the project's current epoch, joined with the credential the token route itself issues for `who`. */
async function joinCurrent(rt: Realtime, who: Identity, projectId: string, topics: { events: string; collab: string }) {
  const { accessToken } = await issueRealtimeToken(who, projectId);
  return { events: await rt.join(await clientWithToken(rt, accessToken), topics.events), collab: await rt.join(await clientWithToken(rt, accessToken), topics.collab) };
}

/** Which of `channels` receive a database-originated Broadcast on `topic` inside the bounded window. */
async function probe(fixture: Fixture, rt: Realtime, topic: string, channels: RealtimeChannel[]) {
  const event = `probe-${randomUUID()}`;
  const seen = channels.map((channel) => rt.receive(channel, event, RECEIVE_TIMEOUT_MS).then(() => true, () => false));
  await controlSend(fixture.database, topic, event);
  return Promise.all(seen);
}

test("removal ends backend access at once, refuses old-epoch joins, moves remaining members to the new epoch and bounds the removed socket by its credential expiry", async (t) => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor, removed] = await Promise.all(["Owner", "Editor", "Removed"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    await fixture.join(owner!, projectId, removed!, "EDITOR");
    const before = await topicsOf(owner!, projectId);
    const { realtimeEpoch: oldEpoch } = await getProjectStatus(owner!, projectId);

    // Sockets joined on the old epoch before the removal: a long-lived owner (the delivery control), the member about to be removed and a member
    // who stays (the provider probe: the same short credential, never removed). Both short credentials expire SHORT_LIFE_S after minting.
    const ownerOld = await rt.join(await clientWithToken(rt, mintScoped(await scopeOf(fixture, owner!, projectId, oldEpoch)).token), before.collab);
    const removedCredential = mintScoped(await scopeOf(fixture, removed!, projectId, oldEpoch), shortLived());
    const removedOld = await rt.join(await clientWithToken(rt, removedCredential.token), before.collab);
    const probeOld = await rt.join(await clientWithToken(rt, mintScoped(await scopeOf(fixture, editor!, projectId, oldEpoch), shortLived()).token), before.collab);
    const baseline = await broadcast(rt, removedOld, [ownerOld, probeOld], true);
    assert.deepEqual([baseline.status, ...baseline.delivered], ["ok", true, true], "before the removal the removed member's socket works");

    const draft = await draftOf(owner!, projectId);
    const member = await memberOf(fixture, removed!, projectId);
    await removeProjectMember(owner!, projectId, member.id, { expectedMemberVersion: member.version, key: randomUUID() }); // rotates the epoch
    const { realtimeEpoch: newEpoch } = await getProjectStatus(owner!, projectId);
    assert.notEqual(newEpoch, oldEpoch);

    // The application refuses the removed member at once: reads, saves and a new credential. Nothing was saved.
    await assert.rejects(getProjectStatus(removed!, projectId), isProjectError);
    await assert.rejects(getDraft(removed!, projectId, draft.draftId), isProjectError);
    await assert.rejects(saveChanges(removed!, projectId, draft.draftId, { ...flowBatch(draft.base.documentRevision).body, key: randomUUID() }), isProjectError);
    assert.equal((await getDraft(owner!, projectId, draft.draftId)).documentRevision, draft.base.documentRevision, "the refused save changed nothing");
    await assert.rejects(issueRealtimeToken(removed!, projectId), (error) => error instanceof ProjectError && error.code === "NOT_FOUND", "the removed member cannot mint a new credential");

    // A fresh join on the old epoch fails for the removed member's credential and for a remaining member's; the new epoch is the control just below.
    for (const [who, topic] of [[removed!, before.collab], [removed!, before.events], [editor!, before.collab]] as const) {
      await assert.rejects(rt.join(await clientWithToken(rt, mintScoped(await scopeOf(fixture, who, projectId, oldEpoch)).token), topic), DENIED);
    }

    // Remaining members see the new epoch and their new channels work: hint, receive and send.
    assert.equal((await getProjectStatus(editor!, projectId)).realtimeEpoch, newEpoch);
    const current = await topicsOf(owner!, projectId);
    assert.deepEqual(current, { events: `project:${projectId}:${newEpoch}:events`, collab: `project:${projectId}:${newEpoch}:collab` });
    const ownerNew = await joinCurrent(rt, owner!, projectId, current);
    const editorNew = await joinCurrent(rt, editor!, projectId, current);
    const hint = rt.receive(editorNew.events, "PROJECT_CHANGED");
    await saveFlow(owner!, projectId);
    assert.equal(parseHint(await hint)?.epoch, newEpoch, "the delivered hint parses and carries the new epoch");
    const live = await broadcast(rt, editorNew.collab, [ownerNew.collab], true);
    assert.deepEqual([live.status, ...live.delivered], ["ok", true]);

    // Record (never fail on) what the already joined removed socket still sees and sends on the old topic before its credential expires.
    const [removedSees, probeSees, ownerSees] = await probe(fixture, rt, before.collab, [removedOld, probeOld, ownerOld]);
    const sent = (await broadcast(rt, removedOld, [ownerOld], false)).delivered[0];
    t.diagnostic(`already joined removed socket, before expiry: receives old-topic Broadcast=${removedSees} (member probe ${probeSees}, unexpired owner ${ownerSees}); its own send reaches the old topic=${sent}`);

    // Expiry: check with a socket that was never removed whether Realtime enforces exp on joined channels. Only then is the removed socket bound by it.
    const deadline = removedCredential.expiresAt * 1000 + HEARTBEAT_MS + 5_000;
    while (Date.now() < deadline && (removedOld.state === "joined" || probeOld.state === "joined")) await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, removedCredential.expiresAt * 1000 - Date.now()))); // never conclude before the credential's own expiry
    const [removedLate, probeLate, ownerLate] = await probe(fixture, rt, before.collab, [removedOld, probeOld, ownerOld]);
    if (ownerSees) assert.equal(ownerLate, true, "the unexpired old-epoch owner socket still receives: the silence below is the credential, not an outage");
    const lost = (channel: RealtimeChannel, received: boolean) => channel.state !== "joined" || !received;
    const enforced = lost(probeOld, probeLate);
    t.diagnostic(enforced
      ? `Realtime enforces exp on joined channels (probe socket state=${probeOld.state}, receives=${probeLate})`
      : `Realtime did NOT enforce exp on joined channels within ${SHORT_LIFE_S} s plus one heartbeat; only the minting refusal bounds a removed member`);
    if (enforced) assert.equal(lost(removedOld, removedLate), true, `the removed socket lost channel access by its credential's expiry (state=${removedOld.state}, receives=${removedLate})`);
  });
});

test("a downgraded member keeps new-epoch Presence and receive but loses collab Broadcast", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor] = await Promise.all(["Owner", "Editor"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    const before = await topicsOf(owner!, projectId);
    const { realtimeEpoch: oldEpoch } = await getProjectStatus(owner!, projectId);
    const draft = await draftOf(owner!, projectId);
    const member = await memberOf(fixture, editor!, projectId);
    await changeProjectMember(owner!, projectId, member.id, { role: "VIEWER", expectedMemberVersion: member.version, key: randomUUID() }); // rotates the epoch
    const { realtimeEpoch } = await getProjectStatus(owner!, projectId);
    assert.notEqual(realtimeEpoch, oldEpoch);
    assert.equal((await getProjectStatus(editor!, projectId)).role, "VIEWER");
    await assert.rejects(saveChanges(editor!, projectId, draft.draftId, { ...flowBatch(draft.base.documentRevision).body, key: randomUUID() }), isProjectError, "the application stops the downgraded member's saves");
    await assert.rejects(rt.join(await clientWithToken(rt, mintScoped(await scopeOf(fixture, editor!, projectId, oldEpoch)).token), before.collab), DENIED, "the old epoch is closed to a fresh join");

    const topics = await topicsOf(owner!, projectId);
    const ownerNew = await joinCurrent(rt, owner!, projectId, topics);
    const viewerNew = await joinCurrent(rt, editor!, projectId, topics);
    const received = await broadcast(rt, ownerNew.collab, [viewerNew.collab], true); // the downgraded member still receives
    assert.deepEqual([received.status, ...received.delivered], ["ok", true]);
    const hint = rt.receive(viewerNew.events, "PROJECT_CHANGED");
    await saveFlow(owner!, projectId);
    assert.ok(parseHint(await hint));
    const seen = rt.receivePresence(ownerNew.collab, "join"); // Presence stays
    assert.equal(await rt.track(viewerNew.collab, { role: "VIEWER" }), "ok");
    await seen;
    const denied = await broadcast(rt, viewerNew.collab, [ownerNew.collab], false); // and collab Broadcast is denied
    assert.deepEqual([denied.status === "ok", ...denied.delivered], [false, false]);
  });
});

test("an archived project keeps reads and Presence while Broadcast and authoring stop", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor] = await Promise.all(["Owner", "Editor"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    const draft = await draftOf(owner!, projectId);
    const { version } = await getProjectStatus(owner!, projectId);
    await archiveProject(owner!, projectId, { expectedProjectVersion: version, reason: "Wrapped up", key: randomUUID() }); // rotates the epoch
    assert.equal((await getProjectStatus(editor!, projectId)).status, "ARCHIVED");
    for (const who of [owner!, editor!]) {
      await assert.rejects(saveChanges(who, projectId, draft.draftId, { ...flowBatch(draft.base.documentRevision).body, key: randomUUID() }), isProjectError, "authoring stops");
    }

    const topics = await topicsOf(owner!, projectId);
    const sockets = { owner: await joinCurrent(rt, owner!, projectId, topics), editor: await joinCurrent(rt, editor!, projectId, topics) }; // members still mint and join
    const event = `control-${randomUUID()}`;
    const controls = [sockets.owner.collab, sockets.owner.events, sockets.editor.collab, sockets.editor.events].map((channel) => rt.receive(channel, event));
    await controlSend(fixture.database, topics.collab, event);
    await controlSend(fixture.database, topics.events, event);
    await Promise.all(controls); // reads still work
    const seen = rt.receivePresence(sockets.owner.collab, "join");
    assert.equal(await rt.track(sockets.editor.collab, { archived: true }), "ok"); // Presence still works
    await seen;
    for (const [sender, listener] of [[sockets.owner.collab, sockets.editor.collab], [sockets.editor.collab, sockets.owner.collab]] as const) {
      const result = await broadcast(rt, sender, [listener], false);
      assert.deepEqual([result.status === "ok", ...result.delivered], [false, false], "collab Broadcast is denied for the owner and the editor alike");
    }
  });
});
