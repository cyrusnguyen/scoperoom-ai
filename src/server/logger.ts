import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEvent = {
  component: string;
  eventName: string;
  outcome: "success" | "failure" | "denied" | "replay";
  requestId?: string;
  routeTemplate?: string;
  httpStatus?: number;
  safeFailureCode?: string;
  durationMs?: number;
  projectId?: string;
};

type LoggerOptions = { environment?: string; releaseId?: string; write?: (line: string) => void };
const components = new Set(["test", "web", "worker"]);
const eventNames = new Set(["access.denied", "logger.delivery_failed", "request.completed", "request.failed"]);
const outcomes = new Set(["success", "failure", "denied", "replay"]);
const environments = new Set(["development", "test", "production"]);
const routes = new Set(["/", "/api/health"]);
const failureCodes = new Set(["INTERNAL_ERROR", "CONFIG_INVALID", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE"]);
const controlled = (value: string, allowed: Set<string>) => allowed.has(value) ? value : "unknown";
const uuid = (value: string | undefined) => value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
const integer = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

export function createLogger(options: LoggerOptions = {}) {
  const write = options.write ?? (line => process.stdout.write(line));
  const base = {
    environment: controlled(options.environment ?? "development", environments),
    releaseId: options.releaseId === "local" || /^[0-9a-f]{40}$/i.test(options.releaseId ?? "") ? options.releaseId : "unknown",
  };
  function log(level: LogLevel, event: LogEvent & Record<string, unknown>) {
    const status = integer(event.httpStatus), duration = integer(event.durationMs);
    const entry = {
      ...base,
      eventId: randomUUID(), timestamp: new Date().toISOString(), level,
      component: controlled(event.component, components),
      eventName: controlled(event.eventName, eventNames),
      outcome: controlled(event.outcome, outcomes),
      ...(uuid(event.requestId) ? { requestId: uuid(event.requestId) } : {}),
      ...(event.routeTemplate && routes.has(event.routeTemplate) ? { routeTemplate: event.routeTemplate } : {}),
      ...(status !== undefined && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
      ...(event.safeFailureCode && failureCodes.has(event.safeFailureCode) ? { safeFailureCode: event.safeFailureCode } : level === "error" ? { safeFailureCode: "INTERNAL_ERROR" } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(uuid(event.projectId) ? { projectId: uuid(event.projectId) } : {}),
    };
    try {
      write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostic delivery must never change the result of the caller's operation.
    }
  }
  return { debug: (event: LogEvent & Record<string, unknown>) => log("debug", event), info: (event: LogEvent & Record<string, unknown>) => log("info", event), warn: (event: LogEvent & Record<string, unknown>) => log("warn", event), error: (event: LogEvent & Record<string, unknown>) => log("error", event) };
}
