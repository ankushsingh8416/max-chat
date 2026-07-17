import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) resolves its worker script with a path
  // relative to its own module location at runtime. Left to Next's default
  // Server Components bundling, that module gets relocated into
  // .next/.../chunks/, which breaks the relative lookup ("Cannot find
  // module '.../chunks/pdf.worker.mjs'"). Excluding both packages from
  // bundling makes Next load them via native `require` from node_modules
  // instead, where the relative path resolves correctly.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
