import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import { signRealtimeToken, type RealtimeScope } from "../../src/features/collaboration/server/sign-token.ts";
import { removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { saveFlow } from "../integration/support/hints.ts";
import { RECEIVE_TIMEOUT_MS, SILENCE_MS, withRealtimeFixture, type Realtime } from "./support.ts";

// Scoped Realtime credential boundary (E36) against the real local stack: tokens are minted by the production signer from the environment
// configuration, joined over real sockets and thrown at the Auth, Data API and Storage surfaces. Every denial is paired with a positive
// control on the same channel or endpoint, so an outage cannot masquerade as a boundary.
const DENIED = /Unauthorized|permissions/i;
const REJECTED = /invalid|jwt|unauthori[sz]ed|expired|permissions/i; // the server's refusal of a bad credential; a bare timeout must not pass
const CLIENT = "app_realtime_client";

function mint(scope: RealtimeScope, now?: number) {
  const signed = signRealtimeToken(scope, { now });
  assert.ok(signed.ok, "set SCOPEROOM_REALTIME_SIGNING_ALG/KEY (and KID for ES256) for this suite; see docs/realtime-setup.md");
  return signed.token;
}

/** An anonymous SDK client whose Realtime socket presents `token`. setAuth is awaited before any channel exists (the SDK's initial token fetch races otherwise). */
async function withToken(rt: Realtime, token: string) {
  const client = await rt.client();
  await client.realtime.setAuth(token);
  return client;
}

/** Evaluates the installed helper as Realtime does for the client role: raw claims text, topic, and the database role Realtime switched to. */
async function clientAllows(database: Client, claims: string, topic: string, capability: string, role = CLIENT) {
  await database.query("begin");
  try {
    await database.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [claims, topic]);
    await database.query(`grant ${CLIENT} to current_user with set true`); // rolled back with the transaction
    await database.query(`set local role ${role}`);
    return (await database.query<{ ok: boolean }>("select app_private.can_realtime($1, $2) as ok", [topic, capability])).rows[0]!.ok;
  } finally {
    await database.query("rollback");
  }
}

async function broadcast(rt: Realtime, sender: Parameters<Realtime["send"]>[0], listeners: Parameters<Realtime["receive"]>[0][], expectDelivery: boolean) {
  const event = `m-${randomUUID()}`;
  const seen = listeners.map((channel) => rt.receive(channel, event, expectDelivery ? RECEIVE_TIMEOUT_MS : SILENCE_MS).then(() => true, () => false));
  const status = await rt.send(sender, event, { n: 1 });
  return { status, delivered: await Promise.all(seen) };
}

test("the scoped credential joins, sends and receives exactly what its member scope allows", async () => {
  await withRealtimeFixture(async (fixture, rt) => {
    const [owner, editor, viewer, stranger, removed] = await Promise.all(["Owner", "Editor", "Viewer", "Stranger", "Removed"].map((label) => fixture.user(label)));
    const projectId = await fixture.project(owner!);
    const otherProject = await fixture.project(stranger!);
    await fixture.join(owner!, projectId, editor!, "EDITOR");
    await fixture.join(owner!, projectId, viewer!, "VIEWER");
    await fixture.join(owner!, projectId, removed!, "EDITOR");
    const { rows: [member] } = await fixture.database.query<{ id: string; version: number }>("select m.profile_id as id, m.version from app.project_membership m join app.user_profile p on p.id = m.profile_id where p.auth_user_id = $1 and m.project_id = $2", [removed!.authUserId, projectId]);
    await removeProjectMember(owner!, projectId, member!.id, { expectedMemberVersion: member!.version, key: randomUUID() }); // rotates the epoch
    const topics = (await getProjectBootstrap(owner!, projectId)).realtime;
    const { realtimeEpoch: epoch } = await getProjectStatus(owner!, projectId);
    const scopeOf = async (who: typeof owner, project = projectId, realtimeEpoch = epoch): Promise<RealtimeScope> => ({ profileId: await fixture.profileId(who!), projectId: project, epoch: realtimeEpoch });
    const [ownerScope, editorScope, viewerScope, strangerScope, removedScope] = await Promise.all([owner, editor, viewer, stranger, removed].map((who) => scopeOf(who)));

    // Members join with their scoped tokens; the database agrees with each result.
    const ownerCollab = await rt.join(await withToken(rt, mint(ownerScope!)), topics.collab);
    const ownerEvents = await rt.join(await withToken(rt, mint(ownerScope!)), topics.events);
    const editorCollab = await rt.join(await withToken(rt, mint(editorScope!)), topics.collab);
    const viewerCollab = await rt.join(await withToken(rt, mint(viewerScope!)), topics.collab);
    const viewerEvents = await rt.join(await withToken(rt, mint(viewerScope!)), topics.events);
    const claimsOf = (scope: RealtimeScope) => JSON.stringify({ role: CLIENT, profile_id: scope.profileId, project_id: scope.projectId, realtime_epoch: scope.epoch });
    assert.equal(await clientAllows(fixture.database, claimsOf(viewerScope!), topics.collab, "receive_broadcast"), true);

    // Broadcast: editor's send reaches everyone (positive control); the viewer's is neither acknowledged nor delivered.
    const editorSend = await broadcast(rt, editorCollab, [ownerCollab, viewerCollab], true);
    assert.deepEqual([editorSend.status, ...editorSend.delivered], ["ok", true, true]);
    assert.equal(await clientAllows(fixture.database, claimsOf(viewerScope!), topics.collab, "send_broadcast"), false);
    const viewerSend = await broadcast(rt, viewerCollab, [ownerCollab, editorCollab], false);
    assert.deepEqual([viewerSend.status === "ok", ...viewerSend.delivered], [false, false, false], "a viewer's scoped token cannot send on collab");

    // Presence: any member, viewer included, may track and is seen.
    const seen = rt.receivePresence(ownerCollab, "join");
    assert.equal(await rt.track(viewerCollab, { role: "VIEWER" }), "ok");
    await seen;

    // Events: nobody sends; the committed hint reaches scoped members (positive control for the silent send below).
    const hint = rt.receive(viewerEvents, "PROJECT_CHANGED");
    await saveFlow(owner!, projectId);
    await hint;
    const ownerSend = await broadcast(rt, ownerEvents, [viewerEvents], false);
    assert.deepEqual([ownerSend.status === "ok", ...ownerSend.delivered], [false, false], "not even the owner's scoped token sends on events");
    assert.equal(await clientAllows(fixture.database, claimsOf(ownerScope!), topics.events, "send_broadcast"), false);

    // Other profile, project and epoch scopes: each is refused although the same topic is joinable by the right scope above.
    const wrongEpoch = randomUUID();
    const refused: [string, RealtimeScope, string][] = [
      ["a stranger's profile", strangerScope!, topics.collab],
      ["a removed member's profile", removedScope!, topics.collab],
      ["a stale-epoch claim on the current topic", { ...ownerScope!, epoch: wrongEpoch }, topics.collab],
      ["another project's claim on this topic", { ...ownerScope!, projectId: otherProject }, topics.collab],
      ["the right claim on a stale topic", ownerScope!, `project:${projectId}:${wrongEpoch}:collab`],
      ["the right claim on another project's topic", ownerScope!, `project:${otherProject}:${epoch}:collab`],
      ["an unrelated profile id", { ...ownerScope!, profileId: randomUUID() }, topics.collab],
    ];
    for (const [label, scope, topic] of refused) {
      assert.equal(await clientAllows(fixture.database, claimsOf(scope), topic, "receive_broadcast"), false, label);
      await assert.rejects(rt.join(await withToken(rt, mint(scope)), topic), DENIED, label);
    }

    // Expired and tampered credentials are refused although a fresh one for the same scope just joined this channel.
    await assert.rejects(rt.join(await withToken(rt, mint(ownerScope!, Date.now() - 400_000)), topics.collab), REJECTED, "expired");
    const [header, payload, signature] = mint(strangerScope!).split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), profile_id: ownerScope!.profileId })).toString("base64url");
    await assert.rejects(rt.join(await withToken(rt, `${header}.${forged}.${signature}`), topics.collab), REJECTED, "tampered claims");
    await assert.rejects(rt.join(await withToken(rt, `${header}.${payload}.${signature.slice(0, -2)}AA`), topics.collab), REJECTED, "tampered signature");
    assert.deepEqual((await broadcast(rt, ownerCollab, [editorCollab], true)).delivered, [true], "the channel still works for the valid scope");
  });
});

test("the helper denies malformed, sub-bearing and role-mismatched claims without raising", async () => {
  await withRealtimeFixture(async ({ database, user, project, profileId, join }) => {
    const [owner, viewer] = await Promise.all(["Owner", "Viewer"].map((label) => user(label)));
    const projectId = await project(owner!);
    await join(owner!, projectId, viewer!, "VIEWER");
    const { rows: [{ epoch }] } = await database.query<{ epoch: string }>("select realtime_epoch::text as epoch from app.project where id = $1", [projectId]);
    const topic = `project:${projectId}:${epoch}:collab`;
    const good = { role: CLIENT, profile_id: await profileId(owner!), project_id: projectId, realtime_epoch: epoch };
    const decide = (claims: unknown, role = CLIENT, capability = "receive_broadcast") => clientAllows(database, typeof claims === "string" ? claims : JSON.stringify(claims), topic, capability, role);

    assert.equal(await decide(good), true, "control");
    assert.equal(await decide({ ...good, profile_id: await profileId(viewer!) }, CLIENT, "send_broadcast"), false, "a viewer profile cannot send");
    assert.equal(await decide({ ...good, sub: viewer!.authUserId }), false, "sub is refused");
    assert.equal(await decide({ ...good, sub: null }), false, "even a null sub");
    assert.equal(await decide(good, "authenticated"), false, "the custom claims are not trusted under another database role");
    assert.equal(await decide({ role: "authenticated", sub: owner!.authUserId }, CLIENT), false, "an Auth-shaped token is not honored under the client role");
    assert.equal(await decide({ ...good, role: "authenticated" }), false);
    for (const value of [null, 7, true, [], {}, "", "not-a-uuid", good.profile_id.toUpperCase(), ` ${good.profile_id}`, [good.profile_id]]) {
      for (const key of ["profile_id", "project_id", "realtime_epoch"] as const) assert.equal(await decide({ ...good, [key]: value }), false, `${key}=${JSON.stringify(value)}`);
    }
    for (const key of Object.keys(good)) assert.equal(await decide({ ...good, [key]: undefined }), false, `missing ${key}`);
    for (const claims of ["", "[]", "\"text\"", "7", "null", "{}", JSON.stringify({ role: CLIENT })]) assert.equal(await decide(claims), false, claims);
    assert.equal(await decide(good, CLIENT, "manage"), false);
    assert.equal(await decide({ ...good, is_anonymous: true }), false, "anonymous marker still denies");
  });
});

test("the scoped credential reaches no Auth account, Data API or Storage operation", async () => {
  await withRealtimeFixture(async (fixture) => { // the fixture also guarantees the guarded setup is verified
    const owner = await fixture.user("Owner");
    const projectId = await fixture.project(owner);
    const scoped = mint({ profileId: await fixture.profileId(owner), projectId, epoch: (await getProjectStatus(owner, projectId)).realtimeEpoch });
    const { accessToken } = await fixture.session(owner);
    const base = process.env.E2E_SUPABASE_URL!;
    const call = async (token: string, path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: response.status, text: await response.text() };
    };

    // Positive control: an ordinary Auth token reaches the account endpoint, so the refusals below are the token's, not an outage.
    const control = await call(accessToken, "/auth/v1/user");
    assert.equal(control.status, 200);
    assert.match(control.text, new RegExp(owner.authUserId));
    // Auth refuses the subject-less token itself (MFA enrollment is disabled locally, so a bare 4xx on /factors would prove nothing): pin the observed codes.
    const attempts: [string, string, { method?: string; body?: unknown }, string][] = [
      ["GET user", "/auth/v1/user", {}, "bad_jwt"],
      ["PUT password", "/auth/v1/user", { method: "PUT", body: { password: `Changed-${randomUUID()}-Pass!` } }, "bad_jwt"],
      ["PUT email", "/auth/v1/user", { method: "PUT", body: { email: `changed-${randomUUID()}@example.test` } }, "bad_jwt"],
      ["POST factors", "/auth/v1/factors", { method: "POST", body: { factor_type: "totp", friendly_name: "boundary" } }, "bad_jwt"],
      ["GET admin users", "/auth/v1/admin/users", {}, "not_admin"],
    ];
    for (const [label, path, init, code] of attempts) {
      const result = await call(scoped, path, init);
      assert.equal(result.status, 403, `${label} status`);
      assert.equal(JSON.parse(result.text).error_code, code, `${label} error_code`);
      assert.ok(!result.text.includes(owner.verifiedEmail) && !result.text.includes(owner.authUserId), `${label} exposed the account`);
    }
    // Data API and Storage: the ordinary token reaches the service (no 5xx) and is answered differently, so the scoped refusal is not an outage.
    for (const [label, path] of [["Data API", "/rest/v1/"], ["Storage buckets", "/storage/v1/bucket"]] as const) {
      const ordinary = await call(accessToken, path);
      const result = await call(scoped, path);
      assert.ok(ordinary.status < 500, `${label} control is reachable (status ${ordinary.status})`);
      assert.ok(result.status >= 400 && result.status < 500, `${label} was refused (status ${result.status})`);
      assert.ok(result.status !== ordinary.status || result.text !== ordinary.text, `${label} answers the scoped token differently from an ordinary one`);
      assert.ok(!result.text.includes(owner.verifiedEmail) && !result.text.includes(owner.authUserId), `${label} exposed the account`);
    }
    // The refused password/email writes changed nothing: the ordinary token still reads the original account.
    const after = await call(accessToken, "/auth/v1/user");
    assert.equal(after.status, 200);
    assert.equal(JSON.parse(after.text).email, owner.verifiedEmail);
  });
});
