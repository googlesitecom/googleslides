import type { NextConfig } from "next";

/**
 * Two build flavors:
 *  - dev / server build (default): standalone server on :3000, no basePath
 *  - static GitHub Pages build (BUILD_STATIC=1): exports ./out with the
 *    repo sub-path as basePath (NEXT_PUBLIC_BASE_PATH, e.g. /gmail), so the
 *    game is playable straight from https://<user>.github.io/<repo>/
 */
const isStatic = process.env.BUILD_STATIC === "1";

const nextConfig: NextConfig = {
  output: isStatic ? "export" : "standalone",
  basePath: isStatic ? (process.env.NEXT_PUBLIC_BASE_PATH || undefined) : undefined,
  trailingSlash: true,          // directory URLs play nice with GitHub Pages
  images: { unoptimized: true }, // no image optimizer on static hosting
  // the install lives in the parent workspace — pin the root so Turbopack
  // doesn't mis-infer it and refuse to compile ./src
  turbopack: { root: __dirname },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
