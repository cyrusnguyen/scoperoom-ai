import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { realtimeClaims, signRealtimeToken } from "../src/features/collaboration/server/sign-token.ts";

const scope = { profileId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", epoch: "33333333-3333-4333-8333-333333333333" };
const secret = "test-only-secret-with-at-least-32-characters";
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const hs256 = { SCOPEROOM_REALTIME_SIGNING_ALG: "HS256", SCOPEROOM_REALTIME_SIGNING_KEY: secret };
const es256 = { SCOPEROOM_REALTIME_SIGNING_ALG: "ES256", SCOPEROOM_REALTIME_SIGNING_KEY: pem, SCOPEROOM_REALTIME_SIGNING_KID: "realtime-key-1" };

test("claims are server-built: fixed labels, integer iat, five-minute expiry and no identity claims", () => {
  assert.deepEqual(realtimeClaims(scope, 1_700_000_000.9), {
    role: "app_realtime_client", iss: "scoperoom", aud: "scoperoom-realtime", iat: 1_700_000_000, exp: 1_700_000_300,
    profile_id: scope.profileId, project_id: scope.projectId, realtime_epoch: scope.epoch,
  });
  // Caller-supplied extras never travel: only the three named scope values are copied.
  const claims = realtimeClaims({ ...scope, sub: "x", role: "authenticated", email: "a@b.c" } as typeof scope, 1);
  for (const forbidden of ["sub", "session_id", "email", "user_metadata", "app_metadata"]) assert.equal(forbidden in claims, false, forbidden);
  assert.equal(claims.role, "app_realtime_client");
});

test("an HS256 token verifies against the configured secret and expires after 300 seconds", () => {
  const result = signRealtimeToken(scope, { env: hs256, now: 1_700_000_000_000 });
  assert.ok(result.ok);
  const [header, payload, signature] = result.token.split(".") as [string, string, string];
  assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });
  assert.equal(signature, createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
  const claims = decode(payload);
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(result.expiresAt, 1_700_000_300);
});

test("an ES256 token carries the kid and a 64-byte P1363 signature that verifies", () => {
  const result = signRealtimeToken(scope, { env: es256 });
  assert.ok(result.ok);
  const [header, payload, signature] = result.token.split(".") as [string, string, string];
  assert.deepEqual(decode(header), { alg: "ES256", typ: "JWT", kid: "realtime-key-1" });
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
  const tampered = Buffer.from(signature, "base64url");
  tampered[0]! ^= 1;
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, tampered), false);
});

test("an ES256 key whose newlines were flattened to literal backslash-n still signs and verifies", () => {
  const flattened = pem.trim().split("\n").join(String.fromCharCode(92) + "n");
  assert.ok(!flattened.includes("\n") && flattened.includes(String.fromCharCode(92) + "n"));
  const result = signRealtimeToken(scope, { env: { ...es256, SCOPEROOM_REALTIME_SIGNING_KEY: flattened } });
  assert.ok(result.ok);
  const [header, payload, signature] = result.token.split(".") as [string, string, string];
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
});

test("missing, invalid or mismatched configuration fails closed and never falls back", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const bad: Record<string, string | undefined>[] = [
    {}, { ...hs256, SCOPEROOM_REALTIME_SIGNING_ALG: undefined }, { ...hs256, SCOPEROOM_REALTIME_SIGNING_ALG: "none" },
    { ...hs256, SCOPEROOM_REALTIME_SIGNING_ALG: "RS256" }, { ...hs256, SCOPEROOM_REALTIME_SIGNING_KEY: undefined },
    { ...hs256, SCOPEROOM_REALTIME_SIGNING_KEY: "short" }, { ...hs256, SCOPEROOM_REALTIME_SIGNING_KEY: pem }, // a PEM is not an HMAC secret
    { ...es256, SCOPEROOM_REALTIME_SIGNING_KID: undefined }, { ...es256, SCOPEROOM_REALTIME_SIGNING_KID: "" },
    { ...es256, SCOPEROOM_REALTIME_SIGNING_KEY: secret }, { ...es256, SCOPEROOM_REALTIME_SIGNING_KEY: rsa }, { ...es256, SCOPEROOM_REALTIME_SIGNING_KEY: p384 },
    { SUPABASE_JWT_SECRET: secret, JWT_SECRET: secret, SCOPEROOM_REALTIME_SIGNING_ALG: "HS256" }, // other secrets are never borrowed
  ];
  for (const env of bad) assert.deepEqual(signRealtimeToken(scope, { env }), { ok: false, reason: "UNAVAILABLE" }, JSON.stringify(Object.keys(env)));
});
