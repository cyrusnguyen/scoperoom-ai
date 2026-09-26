import assert from "node:assert/strict";
import test from "node:test";
import { errorBody, requestIdPattern } from "../src/contracts/http.ts";
import { projectErrors } from "../src/features/projects/contracts/errors.ts";

const requestId = "0b6f6a53-4ad2-4c55-9f0d-6e9f2f7a1c11";

test("error bodies carry the request id and mark only server failures retryable", () => {
  assert.deepEqual(errorBody("CONFLICT", "Refresh and try again.", 409, requestId), { error: { code: "CONFLICT", message: "Refresh and try again.", requestId, retryable: false } });
  assert.equal(errorBody("UNAVAILABLE", "Try again.", 503, requestId).error.retryable, true);
  assert.deepEqual(errorBody("OWNED_PROJECT_LIMIT", "Limit.", 422, requestId, { activeOwned: 10, maxOwned: 10 }).error.details, { activeOwned: 10, maxOwned: 10 });
  assert.match(requestId, requestIdPattern);
});

test("project error statuses match the API contract", () => {
  const statuses = Object.fromEntries(Object.entries(projectErrors).map(([code, entry]) => [code, entry.status]));
  assert.deepEqual(statuses, {
    ENTITLEMENT_REQUIRED: 403, OWNED_PROJECT_LIMIT: 422, OWNER_CANNOT_LEAVE: 409, ALREADY_MEMBER: 409, COLLABORATOR_LIMIT: 422,
    INVITATION_LIMIT: 409, NOT_FOUND: 404, KEY_REUSED: 409, INVALID_INPUT: 400, CONFLICT: 409, FORBIDDEN: 403, UNAVAILABLE: 503,
  });
});
