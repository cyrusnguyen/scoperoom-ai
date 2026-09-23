export type AppEnvironment = "development" | "test" | "production";

export type ProcessEnv = {
  appEnv: AppEnvironment;
  appUrl?: string;
};

const environments = new Set<AppEnvironment>(["development", "test", "production"]);

export function readProcessEnv(values: Partial<NodeJS.ProcessEnv> = process.env): ProcessEnv {
  const appEnv = values.APP_ENV ?? (values.NODE_ENV === "test" ? "test" : values.NODE_ENV === "production" ? "production" : "development");
  if (!environments.has(appEnv as AppEnvironment)) throw new Error("APP_ENV must be development, test, or production.");
  const rawUrl = values.NEXT_PUBLIC_APP_URL;
  if (!rawUrl) {
    if (appEnv === "production") throw new Error("NEXT_PUBLIC_APP_URL is required when APP_ENV is production.");
    return { appEnv: appEnv as AppEnvironment };
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("NEXT_PUBLIC_APP_URL must be an absolute http or https URL."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("NEXT_PUBLIC_APP_URL must use http or https.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("NEXT_PUBLIC_APP_URL must be an origin without credentials, query, or fragment.");
  return { appEnv: appEnv as AppEnvironment, appUrl: url.origin };
}
