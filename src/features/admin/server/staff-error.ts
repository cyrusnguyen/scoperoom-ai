import { ProjectError } from "../../projects/server/errors.ts";

type DriverError = {
  code?: string; message?: string;
  meta?: { code?: string; message?: string; driverAdapterError?: { message?: string; cause?: { code?: string; message?: string; originalMessage?: string } } };
};

/**
 * Maps a staff function refusal (SQLSTATE) to the app error. SR001 and SR005 are both NOT_FOUND so a normal account learns nothing;
 * SR002, SR004 and SR006 are shown to staff; SR003 is the shared version conflict (the caller adds the current version).
 */
export function staffError(error: unknown): ProjectError {
  if (error instanceof ProjectError) return error;
  const candidate = (typeof error === "object" && error !== null ? error : {}) as DriverError;
  const code = candidate.meta?.driverAdapterError?.cause?.code ?? candidate.meta?.code ?? candidate.code;
  const driver = candidate.meta?.driverAdapterError;
  const text = [candidate.message, candidate.meta?.message, driver?.message, driver?.cause?.message, driver?.cause?.originalMessage].join(" ");
  const named = (state: string, name: string) => code === state || text.includes(name);
  if (named("SR001", "STAFF_REQUIRED") || named("SR005", "TARGET_NOT_FOUND")) return new ProjectError("NOT_FOUND");
  if (named("SR002", "ADMIN_REQUIRED")) return new ProjectError("ADMIN_ROLE_REQUIRED");
  if (named("SR006", "TARGET_FORBIDDEN")) return new ProjectError("STAFF_TARGET_FORBIDDEN");
  if (named("SR003", "VERSION_CONFLICT")) return new ProjectError("CONFLICT");
  if (named("SR004", "LAST_ADMIN")) return new ProjectError("LAST_ADMIN");
  if (code === "22023" || text.includes("22023")) return new ProjectError("INVALID_INPUT");
  return new ProjectError("UNAVAILABLE");
}
