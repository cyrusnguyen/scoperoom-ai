export type AppEnvironment = "development" | "test" | "production";

export type ProcessEnv = {
  appEnv: AppEnvironment;
  appUrl?: string;
};

const environments = new Set<AppEnvironment>(["development", "test", "production"]);

function isLoopbackUrl(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false; // The main URL validator reports malformed values.
  }
}
export function readProcessEnv(values: Partial<NodeJS.ProcessEnv> = process.env): ProcessEnv {
  const appEnv = values.APP_ENV ?? (values.NODE_ENV === "test" ? "test" : values.NODE_ENV === "production" ? "production" : "development");
  if (!environments.has(appEnv as AppEnvironment)) throw new Error("APP_ENV must be development, test, or production.");
  let rawUrl = values.NEXT_PUBLIC_APP_URL;
  if (values.VERCEL && (!rawUrl || isLoopbackUrl(rawUrl))) {
    const domain = values.VERCEL_PROJECT_PRODUCTION_URL;
    if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
      throw new Error("A production URL is required on Vercel.");
    }
    rawUrl = `https://${domain}`;
  }
  if (!rawUrl) {
    if (appEnv === "production") throw new Error("NEXT_PUBLIC_APP_URL is required when APP_ENV is production.");
    return { appEnv: appEnv as AppEnvironment };
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("NEXT_PUBLIC_APP_URL must be an absolute http or https URL."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("NEXT_PUBLIC_APP_URL must use http or https.");
  if (values.VERCEL && url.protocol !== "https:") throw new Error("A production URL must use HTTPS on Vercel.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("NEXT_PUBLIC_APP_URL must be an origin without credentials, query, or fragment.");
  return { appEnv: appEnv as AppEnvironment, appUrl: url.origin };
}

// Confirmation links need a public app destination even when a local URL
// was accidentally left in Vercel's environment. No session is put in it.
export function confirmationRedirectUrl(values: Partial<NodeJS.ProcessEnv> = process.env): string {
  const appUrl = readProcessEnv(values).appUrl;
  if (!appUrl) throw new Error("An app URL is required for email confirmation.");
  return `${appUrl}/login`;
}