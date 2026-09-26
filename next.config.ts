import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
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
