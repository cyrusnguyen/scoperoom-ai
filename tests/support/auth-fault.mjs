// Preloaded into a throwaway `next start` (NODE_OPTIONS=--import) by tests/e2e/collaboration-auth-outage.spec.ts. It
// answers only Supabase Auth requests (/auth/v1/) from that server process with a controlled failure while the file named
// by AUTH_FAULT_FILE holds a mode, and passes everything else, and Auth itself once the file is empty, to the real fetch.
// Nothing else in the shared stack is touched, so the disposable stack stays up for other workers and specs.
import { readFileSync } from "node:fs";

const real = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let mode = "";
  try { mode = readFileSync(process.env.AUTH_FAULT_FILE, "utf8").trim(); } catch { /* no file: healthy */ }
  if (mode && url.includes("/auth/v1/")) {
    if (mode === "down") throw new TypeError("fetch failed"); // a transport failure: the SDK reports it as retryable
    if (mode === "502") return new Response("<html>bad gateway</html>", { status: 502 });
    if (mode === "503") return json(503, { msg: "upstream unavailable" });
    if (mode === "429") return json(429, { code: "over_request_rate_limit", msg: "Too many requests" });
    if (mode === "401") return json(401, { code: "bad_jwt", msg: "invalid JWT" });
    if (mode === "session-missing") return json(403, { code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
  }
  return real(input, init);
};
