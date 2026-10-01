import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { issueRealtimeToken } from "../../src/features/collaboration/server/realtime-token.ts";
import { getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const env = { SCOPEROOM_REALTIME_SIGNING_ALG: "HS256", SCOPEROOM_REALTIME_SIGNING_KEY: "integration-only-secret-with-32-plus-characters" };
const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
const payload = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

test("a member gets a credential scoped to their profile, the project and its current epoch", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId }) => {
    const [owner, editor] = [await user("Owner"), await user("Editor")];
    const projectId = await project(owner);
    await join(owner, projectId, editor, "VIEWER");
    for (const who of [owner, editor]) {
      const { accessToken, expiresAt } = await issueRealtimeToken(who, projectId, { env, now: 1_700_000_000_000 });
      assert.equal(expiresAt, 1_700_000_300);
      assert.deepEqual(payload(accessToken), {
        role: "app_realtime_client", iss: "scoperoom", aud: "scoperoom-realtime", iat: 1_700_000_000, exp: expiresAt,
        profile_id: await profileId(who), project_id: projectId, realtime_epoch: (await getProjectStatus(who, projectId)).realtimeEpoch,
      });
    }
  });
});

test("a stranger, a malformed id and a missing project are the same non-disclosing NOT_FOUND", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const [owner, stranger] = [await user("Owner"), await user("Stranger")];
    const projectId = await project(owner);
    await assert.rejects(issueRealtimeToken(stranger, projectId, { env }), code("NOT_FOUND"));
    await assert.rejects(issueRealtimeToken(owner, "not-a-uuid", { env }), code("NOT_FOUND"));
    await assert.rejects(issueRealtimeToken(owner, randomUUID(), { env }), code("NOT_FOUND"));
  });
});

test("missing or malformed signing configuration is unavailable, never a token", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("Owner");
    const projectId = await project(owner);
    for (const bad of [{}, { SCOPEROOM_REALTIME_SIGNING_ALG: "HS256", SCOPEROOM_REALTIME_SIGNING_KEY: "short" }]) {
      await assert.rejects(issueRealtimeToken(owner, projectId, { env: bad }), code("UNAVAILABLE"));
    }
  });
});
