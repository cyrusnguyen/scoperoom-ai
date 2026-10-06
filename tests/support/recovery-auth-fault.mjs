// Preloaded into a throwaway next start for recovery browser tests. It faults only selected Auth operations for that process.
import { readFileSync, writeFileSync } from "node:fs";

const realFetch = globalThis.fetch;
const unavailable = () => new Response(JSON.stringify({ code: "unexpected_failure", msg: "temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
const authOrigin = process.env.RECOVERY_FAULT_AUTH_ORIGIN;
if (!authOrigin || !(authOrigin.startsWith("http://127.0.0.1:") || authOrigin.startsWith("http://localhost:") || authOrigin.startsWith("http://[::1]:")) || new URL(authOrigin).origin !== authOrigin) {
  throw new Error("The recovery fault server requires an exact loopback Auth origin.");
}
if (!process.env.RECOVERY_FAULT_FILE || !process.env.RECOVERY_FAULT_RESULT_FILE) throw new Error("The recovery fault server requires private mode and result files.");

function operation(method, pathname, url) {
  if (method === "POST" && pathname === "/auth/v1/recover") return "recover";
  if (method === "POST" && pathname === "/auth/v1/verify") return "verify";
  if (method === "PUT" && pathname === "/auth/v1/user") return "update";
  if (method === "GET" && pathname === "/auth/v1/user") return "identity";
  if (method === "POST" && pathname === "/auth/v1/logout") return url.searchParams.get("scope") === "global" ? "global-signout" : "local-signout";
  return null;
}

function record(name, status) {
  const path = process.env.RECOVERY_FAULT_RESULT_FILE;
  let events = [];
  try { events = JSON.parse(readFileSync(path, "utf8")); } catch { /* Start a fresh bounded observation. */ }
  if (!Array.isArray(events)) events = [];
  if (events.length >= 100) return;
  events.push({ operation: name, status });
  writeFileSync(path, JSON.stringify(events));
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  let mode = "";
  try { mode = readFileSync(process.env.RECOVERY_FAULT_FILE, "utf8").trim(); } catch { /* no fault mode */ }
  const operationName = operation(method, url.pathname, url);
  if (url.origin !== authOrigin || !url.pathname.startsWith("/auth/v1/") || !operationName || mode === "") return realFetch(input, init);
  if (!["observe", "request-outage", "request-lost", "request-delay", "verify-outage", "verify-expired", "update-outage", "update-lost", "signout-outage", "identity-outage"].includes(mode)) return realFetch(input, init);

  if (mode === "request-delay" && operationName === "recover") {
    await new Promise((resolve) => setTimeout(resolve, 800));
    record(operationName, 400);
    return new Response(JSON.stringify({ code: "validation_failed", msg: "request not accepted" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (mode === "request-lost" && operationName === "recover") {
    const response = await realFetch(input, init);
    record(operationName, response.status);
    return response.ok ? unavailable() : response;
  }
  const shouldFault = mode === "request-outage" && operationName === "recover"
    || mode === "verify-outage" && operationName === "verify"
    || mode === "verify-expired" && operationName === "verify"
    || mode === "update-outage" && operationName === "update"
    || mode === "update-lost" && operationName === "update"
    || mode === "signout-outage" && operationName === "global-signout"
    || mode === "identity-outage" && operationName === "identity";

  if (mode === "update-lost" && operationName === "update") {
    const response = await realFetch(input, init);
    record(operationName, response.status);
    return response.ok ? unavailable() : response;
  }
  if (shouldFault) {
    if (mode === "verify-expired") {
      record(operationName, 400);
      return new Response(JSON.stringify({ code: "otp_expired", msg: "Token has expired or is invalid" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    record(operationName, 503);
    return unavailable();
  }
  const response = await realFetch(input, init);
  record(operationName, response.status);
  return response;
};
