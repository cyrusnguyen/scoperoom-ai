import { createHmac, createPrivateKey, sign } from "node:crypto";

// Server-only signing adapter for the scoped Realtime credential (decision E36). The route (a later task) authorizes; this module only
// builds the claims and signs them. The key is project-wide signing authority: configuration comes from these names and nothing else.
export type RealtimeScope = { profileId: string; projectId: string; epoch: string };
export type SignedRealtimeToken = { ok: true; token: string; expiresAt: number } | { ok: false; reason: "UNAVAILABLE" };

const LIFETIME_SECONDS = 300;
type Config = { alg: "HS256"; key: string } | { alg: "ES256"; key: string; kid: string };

/** Only the three scope values are copied. There is deliberately no sub, session_id, email or caller-selected claim. */
export function realtimeClaims(scope: RealtimeScope, nowSeconds: number) {
  const iat = Math.floor(nowSeconds);
  return { role: "app_realtime_client", iss: "scoperoom", aud: "scoperoom-realtime", iat, exp: iat + LIFETIME_SECONDS, profile_id: scope.profileId, project_id: scope.projectId, realtime_epoch: scope.epoch };
}

/** An HS256 secret (the local stack's) or an ES256 PKCS8 P-256 key with its kid. Anything missing, malformed or mismatched is unavailable. */
function readConfig(env: Record<string, string | undefined>): Config | null {
  const alg = env.SCOPEROOM_REALTIME_SIGNING_ALG, key = env.SCOPEROOM_REALTIME_SIGNING_KEY, kid = env.SCOPEROOM_REALTIME_SIGNING_KID;
  if (!key) return null;
  if (alg === "HS256") return key.length >= 32 && !key.includes("-----BEGIN") ? { alg, key } : null;
  if (alg !== "ES256" || !kid) return null;
  const pem = key.replaceAll("\n", "\n"); // deployment secret stores often flatten newlines
  try {
    const parsed = createPrivateKey(pem);
    return parsed.asymmetricKeyType === "ec" && parsed.asymmetricKeyDetails?.namedCurve === "prime256v1" ? { alg, key: pem, kid } : null;
  } catch {
    return null;
  }
}

export function signRealtimeToken(scope: RealtimeScope, { env = process.env, now = Date.now() }: { env?: Record<string, string | undefined>; now?: number } = {}): SignedRealtimeToken {
  const config = readConfig(env);
  if (!config) return { ok: false, reason: "UNAVAILABLE" };
  const claims = realtimeClaims(scope, now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode(config.alg === "ES256" ? { alg: "ES256", typ: "JWT", kid: config.kid } : { alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = config.alg === "HS256"
    ? createHmac("sha256", config.key).update(unsigned).digest()
    : sign("sha256", Buffer.from(unsigned), { key: config.key, dsaEncoding: "ieee-p1363" }); // JWS wants raw r||s, not DER
  return { ok: true, token: `${unsigned}.${signature.toString("base64url")}`, expiresAt: claims.exp };
}
