import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { poolConfig } from "../src/server/db.ts";

// pg's own parser and merge (untyped internal module), exactly as a pooled client resolves its options.
const ConnectionParameters = createRequire(import.meta.url)("pg/lib/connection-parameters.js") as new (config: object) => { ssl: unknown };

const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("without a CA the connection string is used as given", () => {
  const url = "postgresql://app_web_runtime:pw@127.0.0.1:54329/postgres?sslmode=disable";
  assert.deepEqual(poolConfig(url, {}), { connectionString: url });
  assert.deepEqual(poolConfig(url, { SCOPEROOM_DATABASE_CA_PEM: " " }), { connectionString: url });
});

test("a CA forces verified TLS that the URL's own TLS parameters cannot override", () => {
  const url = "postgresql://app_web_runtime.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&sslrootcert=/x.crt&uselibpqcompat=true&pgbouncer=true";
  const config = poolConfig(url, { SCOPEROOM_DATABASE_CA_PEM: ca });
  assert.equal(config.connectionString, "postgresql://app_web_runtime.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true");
  // pg merges the parsed connection string over explicit options: the CA must survive that merge.
  assert.deepEqual(new ConnectionParameters(config).ssl, { ca, rejectUnauthorized: true });
});

test("no TLS URL parameter can replace the pinned CA", () => {
  for (const query of ["sslnegotiation=direct", "ssl=true", "sslmode=no-verify", "sslmode=disable"]) {
    const config = poolConfig(`postgresql://u:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?${query}`, { SCOPEROOM_DATABASE_CA_PEM: ca });
    assert.deepEqual(new ConnectionParameters(config).ssl, { ca, rejectUnauthorized: true }, query);
  }
});
