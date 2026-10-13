type Env = Partial<NodeJS.ProcessEnv>;
const INNGEST_PATH = "/api/inngest";

/** One codebase, two Vercel projects: only the worker project sets SCOPEROOM_SERVICE=worker. */
export function isWorkerService(env: Env = process.env) {
  return env.SCOPEROOM_SERVICE === "worker";
}

/** The worker project exposes exactly the Inngest endpoint; the web project exposes everything else and never that one. */
export function routeAllowed(service: "web" | "worker", pathname: string) {
  const inngest = pathname === INNGEST_PATH || pathname.startsWith(`${INNGEST_PATH}/`);
  return service === "worker" ? pathname === INNGEST_PATH : !inngest;
}

/** Image-suffixed paths the web service lets through untouched (the worker 404s them first, via routeAllowed). */
export function isStaticAssetPath(pathname: string) {
  return /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname);
}
