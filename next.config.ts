import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * Slim the standalone deploy bundle. The platform packages
   * .next/standalone as the deployment artifact - keep it small:
   *  - @img/sharp + sharp: native image-optimization binaries; this app
   *    does not use next/image optimization at all.
   *  - typescript: build-time only, never needed at runtime.
   *  - @prisma/engines: CLI-side binaries (schema engine for db push /
   *    migrate). The runtime only needs the query engine that ships in
   *    .prisma/client, which stays included.
   */
  outputFileTracingExcludes: {
    "*": [
      "./node_modules/@img/**",
      "./node_modules/sharp/**",
      "./node_modules/typescript/**",
      "./node_modules/@prisma/engines/**",
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
