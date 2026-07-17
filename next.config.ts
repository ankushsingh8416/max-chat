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
  // Separately: Vercel's build-time output file tracer (@vercel/nft) only
  // follows static import/require calls to decide which files get copied
  // into the deployed serverless function. pdfjs-dist loads its worker via
  // a dynamically computed `import(this.workerSrc)`, which the tracer can't
  // follow — so pdf.worker.mjs silently never makes it into the production
  // bundle at all (a 500 with Next's generic error page, since the route
  // module fails to load), even though this isn't visible in local dev
  // (which runs straight off node_modules with no tracing/bundling step).
  outputFileTracingIncludes: {
    "/api/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
