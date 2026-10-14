import assert from "node:assert/strict";
import test from "node:test";
import { deploymentProblem, expectations, maskCommand, releaseOrigin, releaseSha, synced, withRootCert } from "../scripts/release/release.mjs";

test("a database URL is masked only inside GitHub Actions, escaped so the runner masks the printed form", () => {
  const url = "postgresql://u:p%25w@db.example.test:5432/postgres?sslrootcert=%2Ftmp%2Fca.crt";
  assert.equal(maskCommand(url, false), "", "an operator shell must not print the URL");
  assert.equal(maskCommand(url, true), "::add-mask::postgresql://u:p%2525w@db.example.test:5432/postgres?sslrootcert=%252Ftmp%252Fca.crt");
  assert.equal(maskCommand("a\nb", true), "::add-mask::a%0Ab");
});

test("database URLs point at the written CA file and keep their other parameters", () => {
  const url = withRootCert("postgresql://u:p@db.example.test:5432/postgres?sslmode=require&sslrootcert=C%3A%2Fold.crt", "/tmp/ca.crt");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("sslrootcert"), "/tmp/ca.crt");
  assert.equal(parsed.searchParams.get("sslmode"), "require");
  assert.equal([...parsed.searchParams.keys()].length, 2);
});

test("the edge checks cover web health, the gated paths on both origins and nothing else", () => {
  const list = expectations("https://web.example.test", "https://worker.example.test");
  assert.deepEqual(list[0], ["GET", "https://web.example.test/api/health", 200]);
  for (const method of ["GET", "POST", "PUT"]) assert.ok(list.some(([m, u, s]) => m === method && u === "https://web.example.test/api/inngest" && s === 404));
  for (const path of ["/", "/api/health", "/api/projects", "/logo.png"]) assert.ok(list.some(([m, u, s]) => m === "GET" && u === `https://worker.example.test${path}` && s === 404));
  for (const task of ["repair", "cleanup"]) {
    assert.ok(list.some(([m, u, s]) => m === "POST" && u === `https://worker.example.test/api/internal/worker/${task}` && s === 404), "unauthenticated maintenance call");
    assert.ok(list.some(([m, u, s]) => m === "POST" && u === `https://web.example.test/api/internal/worker/${task}` && s === 404));
  }
  assert.equal(list.filter(([, , s]) => s !== 404).length, 1, "only health is expected to succeed");
});

test("only Inngest's registered answer counts as a sync", () => {
  assert.equal(synced(200, { message: "Successfully registered", modified: false }), true);
  assert.equal(synced(200, { message: "Unauthorized" }), false);
  assert.equal(synced(401, { message: "Successfully registered" }), false);
  assert.equal(synced(200, null), false);
});

test("a deploy with a git ref or not READY stops the release", () => {
  assert.equal(deploymentProblem({ readyState: "READY", meta: {} }), null);
  assert.match(deploymentProblem({ readyState: "READY", meta: { gitCommitRef: "HEAD" } }) ?? "", /git ref/);
  assert.match(deploymentProblem({ readyState: "ERROR", meta: {} }) ?? "", /ERROR/);
});

test("the release SHA is a full lower-case commit id", () => {
  assert.equal(releaseSha("23b353dac911d243ff65764fa110dbda0256cea3"), "23b353dac911d243ff65764fa110dbda0256cea3");
  for (const bad of [undefined, "", "23b353d", "23B353DAC911D243FF65764FA110DBDA0256CEA3", "23b353dac911d243ff65764fa110dbda0256cea3\n"]) assert.throws(() => releaseSha(bad), /release SHA/);
});

test("the release origins must be bare https origins, so a local or mistyped value stops before any request", () => {
  assert.equal(releaseOrigin("WEB_URL", "https://web.example.test"), "https://web.example.test");
  assert.equal(releaseOrigin("WEB_URL", "https://web.example.test/"), "https://web.example.test");
  for (const bad of [undefined, "", "http://127.0.0.1:3100", "https://127.0.0.1:3100", "https://localhost", "https://app.localhost", "https://[::1]", "https://0.0.0.0", "https://[::ffff:127.0.0.1]", "https://2130706433", "https://203.0.113.7", "https://web.example.test/app", "https://web.example.test?x=1", "not a url"]) assert.throws(() => releaseOrigin("WEB_URL", bad), /WEB_URL must be/, String(bad));
});
