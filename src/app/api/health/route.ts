import { apiResponse, requestIdFor } from "@/server/web/api-response";

export function GET(request: Request) {
  return apiResponse({ status: "ok", service: "scoperoom-ai", apiVersion: "v1" }, 200, requestIdFor(request));
}
