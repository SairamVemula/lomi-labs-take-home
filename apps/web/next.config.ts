import type { NextConfig } from "next";

const config: NextConfig = {
  // Standalone tracing symlinks node_modules, which needs a privileged shell on Windows; Docker builds run on Linux.
  output: process.platform === "win32" ? undefined : "standalone",
  transpilePackages: ["@lomi/shared"],
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
};

export default config;
