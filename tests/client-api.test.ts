import assert from "node:assert/strict";
import test from "node:test";
import { apiMutate, apiRead } from "../src/client/api.ts";

function stubFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("a success returns the parsed body", async () => {
  const restore = stubFetch(async () => Response.json({ id: "p1" }));
  try { assert.deepEqual(await apiRead("/api/x"), { ok: true, data: { id: "p1" } }); } finally { restore(); }
});

test("an envelope error keeps code, message and details, and is certain below 500", async () => {
  const restore = stubFetch(async () => Response.json({ error: { code: "OWNED_PROJECT_LIMIT", message: "limit", requestId: "r", retryable: false, details: { activeOwned: 10, maxOwned: 10 } } }, { status: 422 }));
  try {
    assert.deepEqual(await apiMutate("/api/projects", "key-0123456789abcdef", { name: "A" }), { ok: false, code: "OWNED_PROJECT_LIMIT", message: "limit", status: 422, details: { activeOwned: 10, maxOwned: 10 }, uncertain: false });
  } finally { restore(); }
});

test("a 5xx without an envelope, or a failed request, is uncertain with a safe message", async () => {
  let restore = stubFetch(async () => new Response("<html>", { status: 503 }));
  try {
    const result = await apiRead("/api/x");
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "UNAVAILABLE"); assert.equal(result.uncertain, true); assert.ok(result.message.length > 0); }
  } finally { restore(); }
  restore = stubFetch(async () => { throw new TypeError("Failed to fetch"); });
  try {
    const result = await apiRead("/api/x");
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "NETWORK"); assert.equal(result.status, 0); assert.equal(result.uncertain, true); }
  } finally { restore(); }
});

test("a mutation sends JSON with its Idempotency-Key, and reads are no-store", async () => {
  const seen: RequestInit[] = [];
  const restore = stubFetch(async (_url, init) => { seen.push(init ?? {}); return Response.json({ ok: 1 }); });
  try {
    await apiMutate("/api/projects/p/leave", "key-0123456789abcdef");
    await apiRead("/api/projects");
    const headers = new Headers(seen[0].headers);
    assert.equal(seen[0].method, "POST");
    assert.equal(headers.get("idempotency-key"), "key-0123456789abcdef");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(seen[0].body, "{}");
    assert.equal(seen[1].cache, "no-store");
  } finally { restore(); }
});

test("a preview POST without a key sends no Idempotency-Key header", async () => {
  const seen: RequestInit[] = [];
  const restore = stubFetch(async (_url, init) => { seen.push(init ?? {}); return Response.json({ ok: 1 }); });
  try {
    await apiMutate("/api/projects/p/drafts/d/arrangement-preview", null, { direction: "TB" });
    assert.equal(new Headers(seen[0].headers).get("idempotency-key"), null);
    assert.equal(seen[0].body, JSON.stringify({ direction: "TB" }));
  } finally { restore(); }
});
