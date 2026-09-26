import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // The dev tools indicator overlays the app shell's bottom corners (bottom-left by default) and can
  // intercept pointer events aimed at the shell footer's Sign out button; it is dev-only and never ships.
  devIndicators: false,
  // Browser tests use their own build output and never replace the normal dev app.
  distDir: process.env.SCOPEROOM_E2E === "1" ? ".next-e2e" : ".next",
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" }] }];
  },
};

export default nextConfig;
