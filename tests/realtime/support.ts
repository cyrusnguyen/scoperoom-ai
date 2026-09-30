import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { signRealtimeToken, type RealtimeScope } from "../../src/features/collaboration/server/sign-token.ts";
import { canRun, withFixture, type Fixture, type Identity } from "../integration/support/fixture.ts";

// Socket verification helpers. Sockets use a real Auth session or a scoped Realtime credential minted by the production signer; never the service secret.
const REQUIRED = ["E2E_SUPABASE_URL", "E2E_SUPABASE_SECRET_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SCOPEROOM_BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID", "NEXT_PUBLIC_APP_URL"];
export const JOIN_TIMEOUT_MS = 10_000;
export const RECEIVE_TIMEOUT_MS = 5_000;
/** Bounded window for asserting that something is NOT delivered; always pair it with a positive control on the same channel. */
export const SILENCE_MS = 1_500;
const SEND_TIMEOUT_MS = 3_000;

export type Capability = "receive_broadcast" | "send_broadcast" | "presence";

export type Realtime = {
  /** A publishable-key client holding the actual verified session of `identity`; without an identity it stays anonymous. */
  client: (identity?: Identity) => Promise<SupabaseClient>;
  /** Resolves only on SUBSCRIBED. Rejects on any terminal state or timeout and removes the channel. */
  join: (client: SupabaseClient, topic: string, options?: { private?: boolean }) => Promise<RealtimeChannel>;
  /** One-shot bounded observer for a Broadcast event; register it BEFORE the send. Resolves with the payload. */
  receive: (channel: RealtimeChannel, event: string, timeoutMs?: number) => Promise<unknown>;
  /** One-shot bounded observer for a Presence event (`join`, `leave`, `sync`). */
  receivePresence: (channel: RealtimeChannel, event: "join" | "leave" | "sync", timeoutMs?: number) => Promise<unknown>;
  /** Broadcast with server acknowledgement. Resolves the client status: "ok", "error" or "timed out". */
  send: (channel: RealtimeChannel, event: string, payload: Record<string, unknown>) => Promise<string>;
  /** Presence track with acknowledgement. */
  track: (channel: RealtimeChannel, payload: Record<string, unknown>) => Promise<string>;
  /** Removes every channel, then signs out every test session. Idempotent. */
  close: () => Promise<void>;
};

let verified = false;
/** Fails closed unless the guarded setup verifies policies and a private-only tenant: a public tenant must not masquerade as a pass. */
function requireGuardedSetup() {
  if (verified) return;
  try {
    execFileSync(process.execPath, ["scripts/db/realtime.mjs", "verify"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? "").split("\n").find((line) => line.startsWith("Error:")) ?? "guarded verification failed";
    throw new Error(`Private Realtime is not ready (run corepack pnpm db:migrate): ${detail.trim().replace(/^Error: /, "")}`);
  }
  verified = true;
}

function makeRealtime(fixture: Fixture): Realtime {
  const clients: SupabaseClient[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const settle = <T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void, timeoutMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { timers.delete(timer); reject(new Error(`${what} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      timers.add(timer);
      const done = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => { clearTimeout(timer); timers.delete(timer); fn(...args); };
      start(done(resolve), done(reject));
    });

  // realtime-js cannot unbind a callback and rejects presence callbacks added after subscribe(), so join() registers one forwarder per event
  // and observers subscribe here. A spent or timed-out observer is removed from the set.
  const presenceObservers = new WeakMap<RealtimeChannel, Set<{ event: string; resolve: (payload: unknown) => void }>>();
  const observe = (channel: RealtimeChannel, type: "broadcast" | "presence", event: string, timeoutMs: number) => {
    let open = true;
    const presence = { event, resolve: (() => {}) as (payload: unknown) => void };
    return settle<unknown>((resolve) => {
      if (type === "presence") { presence.resolve = resolve; presenceObservers.get(channel)!.add(presence); }
      else channel.on("broadcast", { event }, (message: { payload: unknown }) => { if (open) { open = false; resolve(message.payload); } });
    }, timeoutMs, `${type} ${event}`).finally(() => { open = false; presenceObservers.get(channel)?.delete(presence); });
  };

  return {
    client: async (identity) => {
      const client = createClient(process.env.E2E_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
      clients.push(client);
      if (!identity) return client;
      const { accessToken, refreshToken } = await fixture.session(identity);
      const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (error) throw new Error("Could not adopt the test session.");
      await client.realtime.setAuth(accessToken);
      return client;
    },
    join: async (client, topic, options = {}) => {
      const channel = client.channel(topic, { config: { private: options.private ?? true, broadcast: { ack: true, self: false }, presence: { key: crypto.randomUUID() } } });
      const observers = new Set<{ event: string; resolve: (payload: unknown) => void }>();
      presenceObservers.set(channel, observers);
      for (const event of ["join", "leave", "sync"] as const) (channel as unknown as { on: (type: string, filter: { event: string }, callback: (payload: unknown) => void) => void }).on("presence", { event }, (payload) => { for (const observer of observers) if (observer.event === event) observer.resolve(payload); });
      try {
        await settle<void>((resolve, reject) => {
          channel.subscribe((status, error) => {
            if (status === "SUBSCRIBED") resolve();
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") reject(new Error(`channel ${status}${error?.message ? `: ${error.message}` : ""}`));
          });
        }, JOIN_TIMEOUT_MS, "join");
      } catch (error) {
        await client.removeChannel(channel);
        throw error;
      }
      return channel;
    },
    receive: (channel, event, timeoutMs = RECEIVE_TIMEOUT_MS) => observe(channel, "broadcast", event, timeoutMs),
    receivePresence: (channel, event, timeoutMs = RECEIVE_TIMEOUT_MS) => observe(channel, "presence", event, timeoutMs),
    send: (channel, event, payload) => channel.send({ type: "broadcast", event, payload }, { timeout: SEND_TIMEOUT_MS }),
    track: (channel, payload) => channel.track(payload),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled(clients.map((client) => client.removeAllChannels()));
      await Promise.allSettled(clients.map((client) => client.auth.signOut()));
      clients.length = 0;
    },
  };
}

/** Runs `run` with database fixtures plus bounded socket helpers. Missing prerequisites and an unverified tenant are failures, never skips. */
export async function withRealtimeFixture(run: (fixture: Fixture, realtime: Realtime) => Promise<void>) {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length || !canRun) throw new Error(`Realtime tests need a local Supabase stack. Missing: ${missing.join(", ") || "database settings"}. See docs/testing.md.`);
  requireGuardedSetup();
  await withFixture(async (fixture) => {
    const realtime = makeRealtime(fixture);
    try {
      await run(fixture, realtime);
    } finally {
      await realtime.close(); // sockets and sessions first, then withFixture removes accounts
    }
  });
}

const queues = new WeakMap<Client, Promise<unknown>>();
/** Evaluates the installed policy helper for `sub` exactly as the provider policies do, so a socket outcome can be paired with the database decision. Calls on one connection are serialised. */
export function policyAllows(database: Client, sub: string | null, topic: string, capability: Capability, claims: Record<string, unknown> = {}) {
  const run = async () => {
    await database.query("begin");
    try {
      await database.query("set local role authenticated");
      await database.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [sub ? JSON.stringify({ role: "authenticated", sub, ...claims }) : "", topic]);
      return (await database.query<{ ok: boolean }>("select app_private.can_realtime($1, $2) as ok", [topic, capability])).rows[0]!.ok;
    } finally {
      await database.query("rollback");
    }
  };
  const result = (queues.get(database) ?? Promise.resolve()).then(run, run);
  queues.set(database, result.catch(() => {}));
  return result;
}

/** Server-side positive control: a database-originated private Broadcast, which is how PROJECT_CHANGED hints travel. */
export async function controlSend(database: Client, topic: string, event: string, payload: Record<string, unknown> = { control: true }) {
  await database.query("select realtime.send($1::jsonb, $2, $3, true)", [JSON.stringify(payload), event, topic]);
}

/** A scoped Realtime credential from the production signer (the stack's JWT secret). A back-dated `now` (Date.now() - 300_000 + N * 1000) yields a credential with N s left. */
export function mintScoped(scope: RealtimeScope, now?: number) {
  const signed = signRealtimeToken(scope, { now });
  assert.ok(signed.ok, "set SCOPEROOM_REALTIME_SIGNING_ALG/KEY (and KID for ES256) for this suite; see docs/realtime-setup.md");
  return { token: signed.token, expiresAt: signed.expiresAt };
}

/** An anonymous SDK client whose Realtime socket presents `token`. setAuth is awaited before any channel exists (the SDK's initial token fetch races otherwise). */
export async function clientWithToken(realtime: Realtime, token: string) {
  const client = await realtime.client();
  await client.realtime.setAuth(token);
  return client;
}

/** Sends from `sender` and reports the ack plus which of `listeners` received it inside the bounded window (observers exist before the send). */
export async function broadcast(realtime: Realtime, sender: RealtimeChannel, listeners: RealtimeChannel[], expectDelivery: boolean) {
  const event = `m-${crypto.randomUUID()}`;
  const seen = listeners.map((channel) => realtime.receive(channel, event, expectDelivery ? RECEIVE_TIMEOUT_MS : SILENCE_MS).then(() => true, () => false));
  const status = await realtime.send(sender, event, { n: 1 });
  return { status, delivered: await Promise.all(seen) };
}
