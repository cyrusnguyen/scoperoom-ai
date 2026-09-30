import assert from "node:assert/strict";
import test from "node:test";
import { requestLocalTenant } from "../scripts/db/realtime.mjs";

test("tenant setup renews its management credential when the container becomes reachable late", () => {
  let clock = 0, attempts = 0;
  const expiries: number[] = [];
  const result = requestLocalTenant({ docker: "test-docker", projectId: "isolated", secret: "test-only-secret", method: "GET" }, {
    now: () => clock,
    wait: (ms: number) => { clock += ms; },
    run: (_binary: string, _args: string[], options: { input: string }) => {
      const token = options.input.match(/Bearer ([^"\s]+)/)![1]!;
      const { exp } = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { exp: number };
      expiries.push(exp);
      if (++attempts === 1) { clock = 58_000; throw new Error("container starting"); }
      return exp > clock / 1000 ? '{"data":{"private_only":true}}\n200' : '{}\n401';
    },
  });
  assert.deepEqual(result, { status: 200, data: { private_only: true } });
  assert.deepEqual(expiries, [60, 120]);
});

test("an unavailable tenant stops retrying at the deadline", () => {
  let clock = 0;
  assert.throws(() => requestLocalTenant({ docker: "test-docker", projectId: "isolated", secret: "test-only-secret", method: "GET" }, {
    now: () => clock,
    wait: (ms: number) => { clock += ms; },
    run: () => { clock += 15_000; throw new Error("unavailable"); },
  }), /within 60s/);
  assert.ok(clock <= 77_000, "only the bounded final request may run past the deadline");
});
