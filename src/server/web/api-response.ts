import "server-only";
import { randomUUID } from "node:crypto";
import { errorBody, requestIdPattern, type ErrorDetails } from "@/contracts/http";
import { projectErrors } from "@/features/projects/contracts/errors";
import { ProjectError } from "@/features/projects/server/errors";
import { createLogger } from "@/server/logger";

const logger = createLogger({ environment: process.env.APP_ENV });

export function requestIdFor(request: Request) {
  const incoming = request.headers.get("x-request-id");
  return incoming && requestIdPattern.test(incoming) ? incoming : randomUUID();
}

export function apiResponse(body: unknown, status: number, requestId: string) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
}

export function apiError(code: string, message: string, status: number, requestId: string, details?: ErrorDetails) {
  return apiResponse(errorBody(code, message, status, requestId, details), status, requestId);
}

export function apiFailure(error: unknown, requestId: string) {
  if (error instanceof ProjectError) {
    const { status, message } = projectErrors[error.code];
    if (status >= 500) logger.error({ component: "web", eventName: "request.failed", outcome: "failure", requestId, httpStatus: status, safeFailureCode: "SERVICE_UNAVAILABLE" });
    return apiError(error.code, message, status, requestId, error.details);
  }
  logger.error({ component: "web", eventName: "request.failed", outcome: "failure", requestId, httpStatus: 503, safeFailureCode: "INTERNAL_ERROR" });
  return apiError("UNAVAILABLE", projectErrors.UNAVAILABLE.message, 503, requestId);
}
