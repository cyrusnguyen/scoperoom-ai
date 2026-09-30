// Browser side of the scoped Realtime credential (decision E36). One token source per open project and epoch: it is disposed when either
// changes, so a late response can never reach the next source. The SDK transport at the end of this file is the only place a client or channel exists.
import { createClient } from "@supabase/supabase-js";
import type { PeerMessage, PresenceState } from "../features/collaboration/contracts/messages.ts";
import type { LiveConnection, LiveState, RealtimeTransport } from "../features/collaboration/ui/realtime-transport.ts";
import { apiPostEmpty, sessionEnded as endSession, type ApiResult } from "./api.ts";

const RENEW_EARLY_MS = 60_000;

type Credential = { accessToken: string; expiresAt: number }; // the server's expiresAt (Unix seconds) is informational; see lifetimeMs
export type TokenSourceOptions = {
  projectId: string;
  /** The transport must remove its channels and disconnect: a thrown callback alone leaves realtime-js on its previous token. */
  onTeardown: (reason: "denied" | "expired") => void;
  /** True while the token endpoint is unreachable (503/network); false again after a renewal succeeds. */
  onDegraded: (degraded: boolean) => void;
  read?: (url: string) => Promise<ApiResult<Credential>>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => () => void;
  sessionEnded?: (result: ApiResult<unknown>) => boolean;
};
export type TokenSource = { get: () => Promise<string | null>; dispose: () => void; live: () => boolean };

const validCredential = (data: unknown): data is Credential =>
  typeof (data as Credential)?.accessToken === "string" && Number.isFinite((data as Credential).expiresAt);

/**
 * The credential's own lifetime (exp - iat, in ms) from its unverified payload; null when it is not a JWT with numeric claims.
 * Only the lifetime is used: the browser clock is not trusted to agree with the server's, so expiry is anchored to the local send time.
 */
function lifetimeMs(token: string): number | null {
  try {
    const { iat, exp } = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as { iat: unknown; exp: unknown };
    return typeof iat === "number" && typeof exp === "number" && exp > iat ? (exp - iat) * 1000 : null;
  } catch {
    return null;
  }
}

/** A hook that throws must not reject get(): realtime-js would fall back to its previous token. */
const safely = (run: () => void) => { try { run(); } catch { /* the hook is the caller's; the source keeps its own state consistent */ } };

export function createRealtimeTokenSource(o: TokenSourceOptions): TokenSource {
  const read = o.read ?? ((url) => apiPostEmpty<Credential>(url));
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); });
  const sessionEnded = o.sessionEnded ?? endSession;
  let cache: { token: string; expiresAt: number } | null = null; // expiresAt in ms
  let cancelExpiry: (() => void) | null = null;
  let inflight: Promise<string | null> | null = null;
  let disposed = false;
  let degraded = false;

  const clear = () => { cache = null; cancelExpiry?.(); cancelExpiry = null; };
  const setDegraded = (on: boolean) => { if (on !== degraded) { degraded = on; safely(() => o.onDegraded(on)); } };
  const unexpired = () => (cache && cache.expiresAt > now() ? cache.token : null);

  async function renew(): Promise<string | null> {
    const sentAt = now();
    const result = await read(`/api/projects/${o.projectId}/realtime-token`);
    if (disposed) return null; // the project or epoch changed while this request was out
    const life = result.ok && validCredential(result.data) ? lifetimeMs(result.data.accessToken) : null;
    if (result.ok && life !== null) {
      clear();
      cache = { token: result.data.accessToken, expiresAt: sentAt + life }; // conservative: the send precedes the mint
      // Not a renewal poller: it only ends a connection whose credential ran out, and is replaced on every renewal.
      cancelExpiry = setTimer(() => { cancelExpiry = null; cache = null; safely(() => o.onTeardown("expired")); }, Math.max(0, cache.expiresAt - now()));
      setDegraded(false);
      return cache.token;
    }
    if (!result.ok && (result.status === 401 || result.status === 403 || result.status === 404)) {
      dispose();
      safely(() => sessionEnded(result)); // a 401 navigates to sign-in like every other API read
      safely(() => o.onTeardown("denied"));
      return null;
    }
    setDegraded(true);
    const token = unexpired();
    if (!token) clear();
    return token;
  }

  function dispose() { disposed = true; clear(); inflight = null; }

  return {
    // realtime-js calls this on connect and on every heartbeat, so renewal needs no timer of its own.
    get() {
      if (disposed) return Promise.resolve(null);
      if (cache && cache.expiresAt - now() > RENEW_EARLY_MS) return Promise.resolve(cache.token);
      return inflight ??= renew().catch(() => null).finally(() => { inflight = null; });
    },
    dispose,
    live: () => !disposed,
  };
}

/** The SDK client. Its own Auth subsystem is off when `accessToken` is set; the database role in the credential is the boundary. */
export function createRealtimeClient(source: TokenSource, { url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! } = {}) {
  return createClient(url, key, { accessToken: () => source.get() });
}

/**
 * Fetch the credential and await setAuth before the first channel: the SDK's constructor-time initialization is asynchronous,
 * so a first join could otherwise go out with the anonymous key. False means no credential (outage or denial); do not subscribe.
 */
export async function authenticateRealtime(client: { realtime: { setAuth: (token?: string | null) => Promise<void> } }, source: TokenSource): Promise<boolean> {
  const token = await source.get();
  if (!token) return false;
  await client.realtime.setAuth(token);
  return source.live(); // disposed while setAuth was pending: the caller must not subscribe
}

/** The slice of the SDK the transport uses: tests fake it without a network. */
export type SdkChannel = {
  on(type: "broadcast" | "presence", filter: { event: string }, callback: (payload: { payload?: unknown }) => void): SdkChannel;
  subscribe(callback: (status: string) => void): unknown;
  send(message: { type: "broadcast"; event: string; payload: unknown }): Promise<unknown>;
  track(payload: object): Promise<unknown>;
  presenceState(): Record<string, unknown[]>;
};
export type SdkClient = {
  channel(topic: string, options: { config: Record<string, unknown> }): SdkChannel;
  removeAllChannels(): Promise<unknown>;
  realtime: { setAuth: (token?: string | null) => Promise<void>; disconnect: () => Promise<unknown> };
};
export type TransportOptions = {
  makeClient?: (source: TokenSource) => SdkClient;
  token?: Pick<TokenSourceOptions, "read" | "now" | "setTimer" | "sessionEnded">;
  /** Wait before asking for a credential again after an outage. */
  retryMs?: number;
};

const COLLAB_EVENT = "peer";
const HINT_EVENT = "PROJECT_CHANGED";
const FAILED = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

/**
 * One SDK client and exactly two private channels per connection. Listeners are registered before `subscribe()`; `subscribed` needs
 * both SUBSCRIBED. A terminal credential end (denial or expiry) removes the channels and reports `degraded`: the status poll then
 * carries on alone until the project or epoch changes. Disposal removes channels, disconnects and disposes the token source.
 */
export function createSupabaseTransport(options: TransportOptions = {}): RealtimeTransport {
  const makeClient = options.makeClient ?? ((source) => createRealtimeClient(source) as unknown as SdkClient);
  return {
    connect(scope, handlers): LiveConnection {
      let closed = false, dead = false, tokenDegraded = false, reported: LiveState = "connecting";
      const status = { events: "", collab: "" };
      let collab: SdkChannel | null = null, cancelRetry: (() => void) | null = null, released: Promise<void> | null = null;

      const derive = (): LiveState => (dead || tokenDegraded || FAILED.has(status.events) || FAILED.has(status.collab) ? "degraded"
        : status.events === "SUBSCRIBED" && status.collab === "SUBSCRIBED" ? "subscribed" : "connecting");
      const report = () => { const next = derive(); if (!closed && next !== reported) { reported = next; handlers.state(next); } };
      const release = () => released ??= (async () => {
        cancelRetry?.(); cancelRetry = null;
        source.dispose();
        await client.removeAllChannels().catch(() => undefined);
        await client.realtime.disconnect().catch(() => undefined);
      })();

      const source = createRealtimeTokenSource({
        projectId: scope.projectId,
        ...options.token,
        onTeardown: () => { dead = true; report(); void release(); },
        onDegraded: (on) => { tokenDegraded = on; report(); },
      });
      const client = makeClient(source);
      // Only while both channels are joined: realtime-js would otherwise fall back to its REST broadcast endpoint.
      const whenLive = (run: () => void) => {
        if (closed || dead || derive() !== "subscribed") return;
        // Awaiting the token first means a tab that just resumed renews (or tears down) before anything is sent.
        void source.get().then((token) => { if (token && !closed && !dead && derive() === "subscribed") run(); }).catch(() => undefined);
      };

      const join = (purpose: "events" | "collab", wire: (channel: SdkChannel) => void) => {
        const channel = client.channel(scope.topics[purpose], { config: { private: true, broadcast: { self: false, ack: false }, presence: { key: crypto.randomUUID(), enabled: purpose === "collab" } } });
        wire(channel);
        channel.subscribe((value) => { if (closed || dead) return; status[purpose] = value; report(); });
        return channel;
      };

      void (async () => {
        let ready = false;
        for (;;) {
          ready = await authenticateRealtime(client, source).catch(() => false);
          if (closed || dead) return; // disposed or ended while the credential was pending: subscribe nothing
          if (ready) break;
          await new Promise<void>((resolve) => { const timer = setTimeout(() => { cancelRetry = null; resolve(); }, options.retryMs ?? 5_000); cancelRetry = () => { clearTimeout(timer); resolve(); }; });
          if (closed || dead) return;
        }
        join("events", (channel) => { channel.on("broadcast", { event: HINT_EVENT }, (message) => { if (!closed && !dead) handlers.hint(message.payload); }); });
        collab = join("collab", (channel) => {
          channel.on("broadcast", { event: COLLAB_EVENT }, (message) => { if (!closed && !dead) handlers.peer(message.payload); });
          channel.on("presence", { event: "sync" }, () => { if (!closed && !dead) handlers.presence(Object.values(channel.presenceState()).flat()); });
        });
      })();

      return {
        sendPeer: (message: PeerMessage) => whenLive(() => { void collab?.send({ type: "broadcast", event: COLLAB_EVENT, payload: message }).catch(() => undefined); }),
        trackPresence: (state: PresenceState) => whenLive(() => { void collab?.track(state).catch(() => undefined); }),
        dispose: () => { closed = true; return release(); },
      };
    },
  };
}
