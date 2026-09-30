import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult } from "../src/client/api.ts";
import { authenticateRealtime, createRealtimeClient, createRealtimeTokenSource } from "../src/client/realtime.ts";

type Data = { accessToken: string; expiresAt: number };
const T0 = 1_700_000_000; // Unix seconds
/** A JWT-shaped credential minted at server time T0 (iat) expiring at exp; the first segment is a readable tag. */
const jwt = (tag: string, exp: number, iat = T0) => `${tag}.${Buffer.from(JSON.stringify({ iat, exp })).toString("base64url")}.sig`;
const tag = (token: string | null) => token?.split(".")[0] ?? null;
const ok = (name: string, expiresAt = T0 + 300): ApiResult<Data> => ({ ok: true, data: { accessToken: jwt(name, expiresAt), expiresAt } });
const fail = (status: number): ApiResult<Data> => ({ ok: false, code: "X", message: "x", status, uncertain: status === 0 || status >= 500 });

/** A fake clock, a fake timer list and a scripted endpoint; `pending` responses are resolved by the test. */
function harness(script: (call: number) => ApiResult<Data> | Promise<ApiResult<Data>>, { skew = 0, throwing = false } = {}) {
  let nowMs = (T0 + skew) * 1000; // the browser clock may disagree with the server's T0
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const log = { calls: 0, urls: [] as string[], teardown: [] as string[], degraded: [] as boolean[], ended: 0 };
  const source = createRealtimeTokenSource({
    projectId: "p1",
    read: async (url) => { log.urls.push(url); return script(log.calls++); },
    now: () => nowMs,
    setTimer: (run, ms) => { const timer = { at: nowMs + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    onTeardown: (reason) => { log.teardown.push(reason); if (throwing) throw new Error("hook"); },
    onDegraded: (on) => { log.degraded.push(on); if (throwing) throw new Error("hook"); },
    sessionEnded: (result) => { const ended = !result.ok && result.status === 401; if (ended) log.ended++; return ended; },
  });
  const advance = (seconds: number) => {
    nowMs += seconds * 1000;
    for (const timer of timers) if (timer.live && timer.at <= nowMs) { timer.live = false; timer.run(); }
  };
  return { source, log, advance, liveTimers: () => timers.filter((t) => t.live).length };
}

test("a cached credential is reused until 60 seconds before expiry, then renewed", async () => {
  const h = harness((n) => ok(`t${n}`, T0 + 300 + n * 300));
  assert.equal(tag(await h.source.get()), "t0");
  h.advance(239); // 61 s left
  assert.equal(tag(await h.source.get()), "t0");
  assert.equal(h.log.calls, 1);
  h.advance(1); // 60 s left
  assert.equal(tag(await h.source.get()), "t1");
  assert.equal(h.log.calls, 2);
  assert.deepEqual(h.log.urls, ["/api/projects/p1/realtime-token", "/api/projects/p1/realtime-token"]);
});

test("concurrent callers share one in-flight renewal", async () => {
  let release!: (result: ApiResult<Data>) => void;
  const h = harness(() => new Promise((resolve) => { release = resolve; }));
  const all = [h.source.get(), h.source.get(), h.source.get()];
  await Promise.resolve();
  assert.equal(h.log.calls, 1);
  release(ok("shared"));
  assert.deepEqual((await Promise.all(all)).map(tag), ["shared", "shared", "shared"]);
  assert.equal(tag(await h.source.get()), "shared");
  assert.equal(h.log.calls, 1);
});

test("setAuth is awaited with the fetched credential before the caller may subscribe", async () => {
  const h = harness(() => ok("first"));
  const order: string[] = [];
  const client = { realtime: { setAuth: async (token?: string | null) => { order.push(`setAuth:${tag(token ?? null)}`); await Promise.resolve(); order.push("setAuth done"); } } };
  assert.equal(await authenticateRealtime(client, h.source), true);
  order.push("subscribe");
  assert.deepEqual(order, ["setAuth:first", "setAuth done", "subscribe"]);
  const down = harness(() => fail(503));
  assert.equal(await authenticateRealtime(client, down.source), false);
  assert.equal(order.length, 3, "no setAuth without a credential");
});

test("the SDK client is created with the accessToken callback bound to the source", async () => {
  const h = harness(() => ok("cb"));
  const client = createRealtimeClient(h.source, { url: "http://127.0.0.1:1", key: "publishable" });
  assert.equal(tag((await client.realtime.accessToken?.()) ?? null), "cb");
});

test("401, 403 and 404 clear the credential, tear down once and stop the source", async () => {
  for (const status of [401, 403, 404]) {
    const h = harness((n) => (n === 0 ? ok("live") : fail(status)));
    assert.equal(tag(await h.source.get()), "live");
    h.advance(250);
    assert.equal(tag(await h.source.get()), null);
    assert.deepEqual(h.log.teardown, ["denied"], String(status));
    assert.equal(h.log.ended, status === 401 ? 1 : 0);
    assert.equal(h.liveTimers(), 0);
    assert.equal(tag(await h.source.get()), null);
    assert.equal(h.log.calls, 2, "a denied source never asks again");
  }
});

test("an outage keeps only an unexpired credential and reports degraded, then recovers", async () => {
  const h = harness((n) => (n === 1 ? fail(503) : n === 2 ? fail(0) : ok(`t${n}`, n === 0 ? T0 + 300 : T0 + 900)));
  assert.equal(tag(await h.source.get()), "t0");
  h.advance(250); // inside the renewal window, still unexpired
  assert.equal(tag(await h.source.get()), "t0");
  assert.equal(tag(await h.source.get()), "t0");
  assert.deepEqual(h.log.degraded, [true], "degraded is reported once");
  assert.deepEqual(h.log.teardown, []);
  h.advance(50); // the credential expires without a renewal
  assert.deepEqual(h.log.teardown, ["expired"]);
  assert.equal(tag(await h.source.get()), "t3");
  assert.deepEqual(h.log.degraded, [true, false]);
});

test("an outage with no unexpired credential yields none and never a stale one", async () => {
  const h = harness((n) => (n === 0 ? ok("t0") : fail(503)));
  await h.source.get();
  h.advance(299);
  assert.equal(tag(await h.source.get()), "t0"); // 1 s left is still unexpired
  h.advance(1);
  assert.equal(tag(await h.source.get()), null);
  assert.equal(tag(await harness(() => fail(0)).source.get()), null);
});

test("one expiry timer follows the cached credential: rescheduled on renewal, cleared on dispose", async () => {
  const h = harness((n) => ok(`t${n}`, T0 + 300 + n * 240));
  await h.source.get();
  assert.equal(h.liveTimers(), 1);
  h.advance(240);
  await h.source.get(); // renewed to expire at T0+540
  assert.equal(h.liveTimers(), 1, "the old deadline was cancelled");
  h.advance(60); // past the first credential's expiry
  assert.deepEqual(h.log.teardown, [], "the old deadline must not fire");
  h.source.dispose();
  assert.equal(h.liveTimers(), 0);
  h.advance(1000);
  assert.deepEqual(h.log.teardown, []);
});

test("a response that lands after dispose never populates the cache or reports anything", async () => {
  for (const late of [ok("late"), fail(403), fail(401), fail(503)]) {
    let release!: (result: ApiResult<Data>) => void;
    const h = harness(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.source.get();
    await Promise.resolve();
    h.source.dispose();
    release(late);
    assert.equal(await pending, null);
    assert.equal(tag(await h.source.get()), null);
    assert.deepEqual([h.log.calls, h.log.teardown, h.log.degraded, h.log.ended, h.liveTimers()], [1, [], [], 0, 0]);
  }
});

test("a malformed success is an outage, not a credential", async () => {
  const bad = harness(() => ({ ok: true, data: { accessToken: 5, expiresAt: "soon" } as unknown as Data }));
  assert.equal(tag(await bad.source.get()), null);
  assert.deepEqual(bad.log.degraded, [true]);
});

test("the default read is a bodiless POST with no Idempotency-Key", async () => {
  const original = globalThis.fetch;
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return Response.json({ accessToken: jwt("wire", T0 + 300), expiresAt: T0 + 300 }); }) as typeof fetch;
  try {
    const source = createRealtimeTokenSource({ projectId: "p9", onTeardown: () => {}, onDegraded: () => {}, now: () => T0 * 1000, setTimer: () => () => {} });
    assert.equal(tag(await source.get()), "wire");
    assert.equal(seen[0]!.url, "/api/projects/p9/realtime-token");
    assert.equal(seen[0]!.init?.method, "POST");
    assert.equal(seen[0]!.init?.body, undefined);
    assert.equal(seen[0]!.init?.headers, undefined);
  } finally { globalThis.fetch = original; }
});

test("expiry is anchored to the local send time, so browser clock skew cannot force early or late renewal", async () => {
  for (const skew of [600, -120]) {
    const h = harness((n) => ok(`t${n}`, T0 + 300 + n * 300), { skew });
    assert.equal(tag(await h.source.get()), "t0");
    assert.deepEqual(h.log.teardown, [], `no immediate teardown at skew ${skew}`);
    assert.equal(h.liveTimers(), 1);
    h.advance(239); // 61 s before the local deadline
    assert.equal(tag(await h.source.get()), "t0");
    assert.equal(h.log.calls, 1);
    h.advance(1); // 60 s before the local deadline
    assert.equal(tag(await h.source.get()), "t1");
    assert.equal(h.log.calls, 2);
    assert.deepEqual(h.log.teardown, []);
    h.advance(299); // the second credential is still inside its own lifetime
    assert.deepEqual(h.log.teardown, []);
  }
});

test("a credential without numeric iat and exp claims is unavailable and never cached", async () => {
  const payload = (claims: object) => Buffer.from(JSON.stringify(claims)).toString("base64url");
  for (const accessToken of ["opaque", `a.${payload({ exp: T0 + 300 })}.s`, `a.${payload({ iat: "1", exp: "2" })}.s`, `a.${payload({ iat: T0, exp: T0 })}.s`, "a.!!!.s"]) {
    const h = harness(() => ({ ok: true, data: { accessToken, expiresAt: T0 + 300 } }));
    assert.equal(await h.source.get(), null, accessToken);
    assert.deepEqual([h.log.degraded, h.liveTimers()], [[true], 0]);
    assert.equal(await h.source.get(), null);
    assert.equal(h.log.calls, 2, "nothing was cached");
  }
});

test("a throwing hook never makes get() reject", async () => {
  const denied = harness((n) => (n === 0 ? ok("live") : fail(403)), { throwing: true });
  assert.equal(tag(await denied.source.get()), "live");
  denied.advance(250);
  assert.equal(await denied.source.get(), null);
  assert.deepEqual(denied.log.teardown, ["denied"]);
  const outage = harness(() => fail(503), { throwing: true });
  assert.equal(await outage.source.get(), null);
  const expiring = harness(() => ok("t0"), { throwing: true });
  await expiring.source.get();
  expiring.advance(300); // the deadline callback swallows the throwing hook too
  assert.deepEqual(expiring.log.teardown, ["expired"]);
});

test("authenticateRealtime is false when the source was disposed while setAuth was pending", async () => {
  const h = harness(() => ok("t0"));
  const client = { realtime: { setAuth: async () => { await Promise.resolve(); h.source.dispose(); } } };
  assert.equal(await authenticateRealtime(client, h.source), false);
});
