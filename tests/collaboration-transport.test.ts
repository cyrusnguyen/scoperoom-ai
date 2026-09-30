import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult } from "../src/client/api.ts";
import { createSupabaseTransport, type SdkChannel, type SdkClient } from "../src/client/realtime.ts";
import type { PeerMessage, PresenceState } from "../src/features/collaboration/contracts/messages.ts";
import type { LiveState } from "../src/features/collaboration/ui/realtime-transport.ts";

// The SDK transport against a minimal fake client: ordering, aggregation and teardown, without a network. Delivery and RLS are the
// stack suite's job (tests/realtime).
const T0 = 1_700_000_000;
const jwt = (tag: string) => `${tag}.${Buffer.from(JSON.stringify({ iat: T0, exp: T0 + 300 })).toString("base64url")}.sig`;
const good = (tag = "t"): ApiResult<{ accessToken: string; expiresAt: number }> => ({ ok: true, data: { accessToken: jwt(tag), expiresAt: T0 + 300 } });
const refused = (status: number): ApiResult<{ accessToken: string; expiresAt: number }> => ({ ok: false, code: "X", message: "x", status, uncertain: status === 0 || status >= 500 });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const scope = { projectId: "p", epoch: "e", topics: { events: "project:p:e:events", collab: "project:p:e:collab" } };

type FakeChannel = SdkChannel & {
  topic: string; config: Record<string, unknown>; log: string[]; status: (value: string) => void;
  handlers: Map<string, (payload: { payload?: unknown }) => void>; sent: unknown[]; tracked: unknown[]; presence: Record<string, unknown[]>;
};

function harness(script: (call: number) => ApiResult<{ accessToken: string; expiresAt: number }> = () => good(), retryMs = 5) {
  let nowMs = T0 * 1000, calls = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const channels: FakeChannel[] = [];
  const log: string[] = [];
  let token!: Parameters<NonNullable<Parameters<typeof createSupabaseTransport>[0]>["makeClient"] & {}>[0];
  const client: SdkClient = {
    channel(topic, options) {
      const channel: FakeChannel = {
        topic, config: options.config, log: [], handlers: new Map(), sent: [], tracked: [], presence: {}, status: () => undefined,
        on(type, filter, callback) { channel.log.push(`on:${type}:${filter.event}`); channel.handlers.set(`${type}:${filter.event}`, callback); return channel; },
        subscribe(callback) { channel.log.push("subscribe"); channel.status = callback; },
        send: async (message) => { channel.sent.push(message); return "ok"; },
        track: async (payload) => { channel.tracked.push(payload); return "ok"; },
        presenceState: () => channel.presence,
      };
      channels.push(channel);
      log.push(`channel:${topic}`);
      return channel;
    },
    removeAllChannels: async () => { log.push("removeAllChannels"); },
    realtime: { setAuth: async () => { log.push("setAuth"); }, disconnect: async () => { log.push("disconnect"); } },
  };
  const transport = createSupabaseTransport({
    makeClient: (source) => { token = source; return client; },
    retryMs,
    token: {
      read: async () => script(calls++), now: () => nowMs,
      setTimer: (run, ms) => { const timer = { at: nowMs + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
      sessionEnded: () => false,
    },
  });
  const states: LiveState[] = [], hints: unknown[] = [], peers: unknown[] = [], presences: unknown[][] = [];
  const connection = transport.connect(scope, { state: (v) => states.push(v), hint: (v) => hints.push(v), peer: (v) => peers.push(v), presence: (v) => presences.push(v) });
  const [events, collab] = [() => channels.find((c) => c.topic === scope.topics.events)!, () => channels.find((c) => c.topic === scope.topics.collab)!];
  return {
    connection, channels, log, states, hints, peers, presences, events, collab, timers,
    get token() { return token; },
    liveDeadlines: () => timers.filter((timer) => timer.live).length,
    passSeconds: (seconds: number) => { nowMs += seconds * 1000; },
    async subscribeBoth() { await settle(); events().status("SUBSCRIBED"); collab().status("SUBSCRIBED"); },
  };
}
const peer = { type: "CURSOR" } as unknown as PeerMessage;
const state = { flowId: null } as unknown as PresenceState;

test("transport: authenticates before any channel; two private channels; listeners are registered before subscribe()", async () => {
  const h = harness();
  assert.equal(h.channels.length, 0, "no channel before the credential is set");
  await settle();
  assert.deepEqual(h.log.slice(0, 2), ["setAuth", `channel:${scope.topics.events}`]);
  assert.equal(h.channels.length, 2);
  for (const channel of h.channels) {
    assert.equal(channel.config.private, true);
    assert.equal(channel.log.at(-1), "subscribe");
    assert.ok(channel.log.length > 1, "at least one listener precedes subscribe()");
  }
  assert.deepEqual(h.events().log, ["on:broadcast:PROJECT_CHANGED", "subscribe"]);
  assert.deepEqual(h.collab().log, ["on:broadcast:peer", "on:presence:sync", "subscribe"]);
  assert.deepEqual(h.states, []);
});

test("transport: subscribed only when both channels are SUBSCRIBED; an error, timeout or close degrades; recovery needs both again", async () => {
  const h = harness();
  await settle();
  h.events().status("SUBSCRIBED");
  assert.deepEqual(h.states, []);
  h.collab().status("SUBSCRIBED");
  assert.deepEqual(h.states, ["subscribed"]);
  for (const failure of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
    h.states.length = 0;
    h.collab().status(failure);
    assert.deepEqual(h.states, ["degraded"], failure);
    h.events().status(failure);
    h.collab().status("SUBSCRIBED");
    assert.deepEqual(h.states, ["degraded"], "one channel still down");
    h.events().status("SUBSCRIBED");
    assert.deepEqual(h.states, ["degraded", "subscribed"]);
  }
});

test("transport: hints, peer packets and Presence are forwarded untouched and untrusted", async () => {
  const h = harness();
  await settle();
  h.events().handlers.get("broadcast:PROJECT_CHANGED")!({ payload: { hint: 1 } });
  h.collab().handlers.get("broadcast:peer")!({ payload: { peer: 1 } });
  h.collab().presence = { a: [{ presence_ref: "1", s: 1 }], b: [{ presence_ref: "2", s: 2 }, { presence_ref: "3", s: 3 }] };
  h.collab().handlers.get("presence:sync")!({});
  assert.deepEqual(h.hints, [{ hint: 1 }]);
  assert.deepEqual(h.peers, [{ peer: 1 }]);
  assert.deepEqual(h.presences, [[{ presence_ref: "1", s: 1 }, { presence_ref: "2", s: 2 }, { presence_ref: "3", s: 3 }]]);
});

test("transport: sends only on the collab channel and only while both channels are subscribed", async () => {
  const h = harness();
  await settle();
  h.connection.sendPeer(peer); h.connection.trackPresence(state);
  await settle();
  assert.equal(h.collab().sent.length + h.collab().tracked.length, 0, "connecting: never (realtime-js would fall back to REST)");
  await h.subscribeBoth();
  h.connection.sendPeer(peer); h.connection.trackPresence(state);
  await settle();
  assert.deepEqual(h.collab().sent, [{ type: "broadcast", event: "peer", payload: peer }]);
  assert.deepEqual(h.collab().tracked, [state]);
  assert.deepEqual(h.events().sent, [], "browsers never send on events");
  h.events().status("CHANNEL_ERROR");
  h.connection.sendPeer(peer);
  await settle();
  assert.equal(h.collab().sent.length, 1);
});

test("transport: a send after a suspended tab resumes waits for the token source, and is dropped if it ends the connection", async () => {
  const h = harness((call) => (call === 0 ? good("first") : refused(403)));
  await h.subscribeBoth();
  h.passSeconds(250); // 50 s of credential left: inside the renew window, as after a long suspend
  h.connection.sendPeer(peer);
  await settle();
  assert.equal(h.collab().sent.length, 0, "the renewal was denied: the send never leaves");
  assert.deepEqual(h.states, ["subscribed", "degraded"]);
  assert.ok(h.log.includes("removeAllChannels") && h.log.includes("disconnect"));
});

test("transport: terminal denial tears down channels and stops sends; the credential deadline is cancelled", async () => {
  const h = harness((call) => (call === 0 ? good() : refused(401)));
  await h.subscribeBoth();
  assert.equal(h.liveDeadlines(), 1, "one credential-expiry deadline");
  h.passSeconds(250);
  assert.equal(await h.token.get(), null);
  assert.deepEqual(h.states, ["subscribed", "degraded"]);
  assert.deepEqual(h.log.slice(-2), ["removeAllChannels", "disconnect"]);
  assert.equal(h.token.live(), false);
  assert.equal(h.liveDeadlines(), 0);
  h.events().status("SUBSCRIBED"); h.collab().status("SUBSCRIBED"); // late provider callbacks change nothing
  h.connection.sendPeer(peer);
  await settle();
  assert.deepEqual(h.states, ["subscribed", "degraded"]);
  assert.equal(h.collab().sent.length, 0);
  await h.connection.dispose();
  assert.equal(h.log.filter((entry) => entry === "removeAllChannels").length, 1, "teardown then dispose releases once");
});

test("transport: a credential that runs out ends the connection as degraded", async () => {
  const h = harness();
  await h.subscribeBoth();
  h.passSeconds(301);
  h.timers.find((timer) => timer.live)!.run();
  assert.deepEqual(h.states, ["subscribed", "degraded"]);
  assert.ok(h.log.includes("removeAllChannels"));
});

test("transport: denial before the first join creates no channel", async () => {
  const h = harness(() => refused(403));
  await settle(); await settle();
  assert.equal(h.channels.length, 0);
  assert.deepEqual(h.states, ["degraded"]);
});

test("transport: an outage at connect is degraded and retried; the channels join once the endpoint answers", async () => {
  let up = false;
  const h = harness(() => (up ? good() : refused(503)), 5);
  await settle();
  assert.equal(h.channels.length, 0);
  assert.deepEqual(h.states, ["degraded"]);
  up = true;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.channels.length, 2);
  h.events().status("SUBSCRIBED"); h.collab().status("SUBSCRIBED");
  assert.deepEqual(h.states, ["degraded", "connecting", "subscribed"], "the renewed credential clears the outage, then both channels join");
  await h.connection.dispose();
});

test("transport: dispose while the credential is pending subscribes nothing; dispose later removes channels, disconnects and ends the source", async () => {
  const early = harness();
  const pending = early.connection.dispose();
  await pending; await settle();
  assert.equal(early.channels.length, 0);
  assert.equal(early.token.live(), false);
  assert.deepEqual(early.log.filter((entry) => entry !== "setAuth"), ["removeAllChannels", "disconnect"]);

  const h = harness();
  await h.subscribeBoth();
  await h.connection.dispose();
  assert.deepEqual(h.log.slice(-2), ["removeAllChannels", "disconnect"]);
  assert.equal(h.token.live(), false);
  assert.equal(h.liveDeadlines(), 0);
  h.events().handlers.get("broadcast:PROJECT_CHANGED")!({ payload: 1 });
  h.collab().status("CLOSED"); // the removal's own CLOSED is not reported
  assert.deepEqual(h.states, ["subscribed"]);
  assert.deepEqual(h.hints, []);
});
