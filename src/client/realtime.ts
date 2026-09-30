// Browser side of the scoped Realtime credential (decision E36). One token source per open project and epoch: it is disposed when either
// changes, so a late response can never reach the next source. Channels and presence are the transport's job, not this file's.
import { createClient } from "@supabase/supabase-js";
import { apiPostEmpty, sessionEnded as endSession, type ApiResult } from "./api.ts";

const RENEW_EARLY_MS = 60_000;

type Credential = { accessToken: string; expiresAt: number }; // expiresAt in Unix seconds
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
export type TokenSource = { get: () => Promise<string | null>; dispose: () => void };

const validCredential = (data: unknown): data is Credential =>
  typeof (data as Credential)?.accessToken === "string" && Number.isFinite((data as Credential).expiresAt);

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
  const setDegraded = (on: boolean) => { if (on !== degraded) { degraded = on; o.onDegraded(on); } };
  const unexpired = () => (cache && cache.expiresAt > now() ? cache.token : null);

  async function renew(): Promise<string | null> {
    const result = await read(`/api/projects/${o.projectId}/realtime-token`);
    if (disposed) return null; // the project or epoch changed while this request was out
    if (result.ok && validCredential(result.data)) {
      clear();
      cache = { token: result.data.accessToken, expiresAt: result.data.expiresAt * 1000 };
      // Not a renewal poller: it only ends a connection whose credential ran out, and is replaced on every renewal.
      cancelExpiry = setTimer(() => { cancelExpiry = null; cache = null; o.onTeardown("expired"); }, Math.max(0, cache.expiresAt - now()));
      setDegraded(false);
      return cache.token;
    }
    if (!result.ok && (result.status === 401 || result.status === 403 || result.status === 404)) {
      dispose();
      sessionEnded(result); // a 401 navigates to sign-in like every other API read
      o.onTeardown("denied");
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
      return inflight ??= renew().finally(() => { inflight = null; });
    },
    dispose,
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
  return true;
}
