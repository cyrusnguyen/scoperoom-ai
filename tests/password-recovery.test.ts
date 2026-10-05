import assert from "node:assert/strict";
import test from "node:test";
import type { RecoveryClient as ProviderClient } from "../src/features/access/server/password-recovery.ts";

const recovery = await import("../src/features/access/server/password-recovery.ts").catch(() => null);

type RecoveryClient = {
  auth: {
    resetPasswordForEmail: (email: string) => Promise<{ data: unknown; error: unknown }>;
    verifyOtp: (input: { email: string; token: string; type: "recovery" }) => Promise<unknown>;
    updateUser: (input: { password: string }) => Promise<unknown>;
    signOut: (options: { scope: "global" | "local" }) => Promise<{ error: unknown }>;
  };
};

const verifiedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ada@example.test",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  is_anonymous: false,
};
const verifiedSession = {
  access_token: "opaque-session-token",
  user: verifiedUser,
};

function client(overrides: Partial<RecoveryClient["auth"]> = {}) {
  const calls: Array<[string, unknown]> = [];
  const auth: RecoveryClient["auth"] = {
    resetPasswordForEmail: async (email) => {
      calls.push(["resetPasswordForEmail", email]);
      return { data: {}, error: null };
    },
    verifyOtp: async (input) => {
      calls.push(["verifyOtp", input]);
      return { data: { user: verifiedUser, session: verifiedSession }, error: null };
    },
    updateUser: async (input) => {
      calls.push(["updateUser", input]);
      return { data: { user: verifiedUser, session: verifiedSession }, error: null };
    },
    signOut: async (options) => {
      calls.push(["signOut", options]);
      return { error: null };
    },
    ...overrides,
  };
  return { auth, calls } as unknown as { auth: ProviderClient["auth"]; calls: Array<[string, unknown]> };
}

const validInput = {
  email: " ADA@example.test ",
  code: "012345",
  password: "  correct horse battery  ",
  confirmation: "  correct horse battery  ",
  next: "/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

function operations() {
  assert.ok(recovery, "password-recovery operations module and exports must exist");
  return recovery;
}

test("valid recovery input normalizes the email and preserves password bytes and safe continuation", () => {
  const { validateRecoveryInput } = operations();
  assert.deepEqual(validateRecoveryInput(validInput), {
    email: "ada@example.test",
    code: "012345",
    password: validInput.password,
    confirmation: validInput.confirmation,
    next: validInput.next,
  });
});

test("recovery validation rejects malformed email, non-ASCII or wrong-length codes, invalid password bounds, mismatch and unsafe continuation", () => {
  const { validateRecoveryInput } = operations();
  const invalid = [
    { ...validInput, email: "not-an-email" },
    { ...validInput, email: `a${"x".repeat(320)}@example.test` },
    { ...validInput, code: "12345" },
    { ...validInput, code: "1234567" },
    { ...validInput, code: "１２３４５６" },
    { ...validInput, code: "12 456" },
    { ...validInput, password: "x".repeat(7), confirmation: "x".repeat(7) },
    { ...validInput, password: "x".repeat(1025), confirmation: "x".repeat(1025) },
    { ...validInput, confirmation: "a different password" },
    { ...validInput, next: "https://example.test/" },
    { ...validInput, next: "//example.test/" },
    { ...validInput, next: "/invite/not-a-token" },
    { ...validInput, next: 5 },
  ];
  for (const input of invalid) assert.throws(() => validateRecoveryInput(input));
  assert.equal(validateRecoveryInput({ ...validInput, password: "x".repeat(8), confirmation: "x".repeat(8) }).password.length, 8);
  assert.equal(validateRecoveryInput({ ...validInput, password: "x".repeat(1024), confirmation: "x".repeat(1024) }).password.length, 1024);
});

test("invalid recovery input is rejected before verification or password update", async () => {
  const { recoverPassword } = operations();
  const fake = client();
  assert.deepEqual(await recoverPassword(fake, { ...validInput, password: "short", confirmation: "short" }), { kind: "invalid-input" });
  assert.deepEqual(fake.calls, []);
});

test("recovery request uses resetPasswordForEmail and treats address-specific suppression as accepted", async () => {
  const { requestPasswordReset } = operations();
  const fake = client({
    resetPasswordForEmail: async (email) => {
      fake.calls.push(["resetPasswordForEmail", email]);
      return { data: null, error: { code: "over_email_send_rate_limit", status: 429 } as never };
    },
  });
  assert.deepEqual(await requestPasswordReset(fake, " ADA@example.test "), { kind: "accepted" });
  assert.deepEqual(fake.calls, [["resetPasswordForEmail", "ada@example.test"]]);
});

test("recovery request distinguishes a global outage from address-specific suppression", async () => {
  const { requestPasswordReset } = operations();
  const fake = client({ resetPasswordForEmail: async () => ({ data: null, error: { code: "over_request_rate_limit", status: 429 } as never }) });
  assert.deepEqual(await requestPasswordReset(fake, "ada@example.test"), { kind: "unavailable" });
});

test("valid recovery verifies the recovery OTP before one update and global session revocation", async () => {
  const { recoverPassword } = operations();
  const fake = client();
  assert.deepEqual(await recoverPassword(fake, validInput), { kind: "updated" });
  assert.deepEqual(fake.calls, [
    ["verifyOtp", { email: "ada@example.test", token: "012345", type: "recovery" }],
    ["updateUser", { password: validInput.password }],
    ["signOut", { scope: "global" }],
  ]);
});

test("invalid or mismatched verification never updates and attempts local cleanup only for a returned session", async () => {
  const { recoverPassword } = operations();
  const fake = client({ verifyOtp: async (input) => {
    fake.calls.push(["verifyOtp", input]);
    return { data: { user: verifiedUser, session: verifiedSession }, error: { code: "otp_expired", status: 400 } };
  } });
  assert.deepEqual(await recoverPassword(fake, validInput), { kind: "invalid-code" });
  assert.deepEqual(fake.calls.map(([name, value]) => [name, name === "signOut" ? value : null]), [
    ["verifyOtp", null],
    ["signOut", { scope: "local" }],
  ]);

  const mismatched = client({ verifyOtp: async (input) => {
    mismatched.calls.push(["verifyOtp", input]);
    return { data: { user: verifiedUser, session: { ...verifiedSession, user: { ...verifiedUser, id: "22222222-2222-4222-8222-222222222222" } } }, error: null };
  } });
  assert.deepEqual(await recoverPassword(mismatched, validInput), { kind: "invalid-code" });
  assert.equal(mismatched.calls.some(([name]) => name === "updateUser"), false);
});

test("explicit password refusal requires a fresh code and best-effort local cleanup preserves that result", async () => {
  const { recoverPassword } = operations();
  const fake = client({
    updateUser: async (input) => {
      fake.calls.push(["updateUser", input]);
      return { data: { user: null, session: null }, error: { code: "weak_password", status: 422 } };
    },
    signOut: async (options) => {
      fake.calls.push(["signOut", options]);
      throw new Error("private provider detail");
    },
  });
  assert.deepEqual(await recoverPassword(fake, validInput), { kind: "new-code-required" });
  assert.equal(fake.calls.filter(([name]) => name === "updateUser").length, 1);
  assert.deepEqual(fake.calls.at(-1), ["signOut", { scope: "local" }]);
});

test("uncertain or mismatched update acknowledgement never reports success and only attempts local cleanup", async () => {
  const { recoverPassword } = operations();
  const fake = client({ updateUser: async (input) => {
    fake.calls.push(["updateUser", input]);
    return { data: { user: { ...verifiedUser, id: "22222222-2222-4222-8222-222222222222" }, session: null }, error: null };
  } });
  assert.deepEqual(await recoverPassword(fake, validInput), { kind: "update-unknown" });
  assert.deepEqual(fake.calls.at(-1), ["signOut", { scope: "local" }]);
});

test("confirmed password update remains confirmed when global sign-out fails", async () => {
  const { recoverPassword } = operations();
  const fake = client({ signOut: async (options) => {
    fake.calls.push(["signOut", options]);
    return { error: { code: "unexpected_failure", status: 503 } };
  } });
  assert.deepEqual(await recoverPassword(fake, validInput), { kind: "updated-with-signout-warning" });
  assert.equal(fake.calls.filter(([name]) => name === "updateUser").length, 1);
  assert.deepEqual(fake.calls.at(-1), ["signOut", { scope: "global" }]);
});
