import { timingSafeEqual } from "node:crypto";

type Env = Partial<NodeJS.ProcessEnv>;
const INNGEST_PATH = "/api/inngest";
const MAINTENANCE_PREFIX = "/api/internal/worker/";
export const MAINTENANCE_PATHS = { repair: "/api/internal/worker/repair", cleanup: "/api/internal/worker/cleanup" } as const;
const WORKER_PATHS = new Set<string>([INNGEST_PATH, ...Object.values(MAINTENANCE_PATHS)]);

/** One codebase, two Vercel projects: only the worker project sets SCOPEROOM_SERVICE=worker. */
export function isWorkerService(env: Env = process.env) {
  return env.SCOPEROOM_SERVICE === "worker";
}

/** The worker project exposes exactly the Inngest endpoint and the two maintenance endpoints; the web project never exposes any of them. */
export function routeAllowed(service: "web" | "worker", pathname: string) {
  if (service === "worker") return WORKER_PATHS.has(pathname);
  return !(pathname === INNGEST_PATH || pathname.startsWith(`${INNGEST_PATH}/`) || pathname.startsWith(MAINTENANCE_PREFIX));
}

/** Constant-time bearer check for the pg_cron calls; a missing or short secret, or a non-worker process, never authorizes. */
export function workerRequestAllowed(authorization: string | null, env: Env = process.env) {
  const secret = env.SCOPEROOM_WORKER_SECRET;
  if (!isWorkerService(env) || !secret || secret.length < 32 || !authorization) return false;
  const given = Buffer.from(authorization), expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Image-suffixed paths the web service lets through untouched (the worker 404s them first, via routeAllowed). */
export function isStaticAssetPath(pathname: string) {
  return /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname);
}
