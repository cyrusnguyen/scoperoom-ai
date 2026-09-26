import type { ErrorDetails } from "../../../contracts/http.ts";
import type { ProjectErrorCode } from "../contracts/errors.ts";

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly details?: ErrorDetails;

  constructor(code: ProjectErrorCode, details?: ErrorDetails) {
    super(code);
    this.name = "ProjectError";
    this.code = code;
    this.details = details;
  }
}
