import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (via pdfjs-dist) dynamically imports its worker script using a
  // path computed relative to its own module location at runtime
  // (`import(this.workerSrc)`), which bundlers can't statically follow.
  // lib/content/pdf.ts overrides that guess with an explicitly-resolved
  // absolute path via PDFParse.setWorker(), so pdf-parse/pdfjs-dist are left
  // to bundle normally here (do NOT add them to serverExternalPackages —
  // that was tried and made things worse: without normal bundling, the
  // *entire* package tree must be require()-able from raw node_modules at
  // runtime, and Vercel's file tracer doesn't reliably capture everything
  // pdfjs-dist touches, so even non-PDF uploads started failing at module
  // load). This outputFileTracingIncludes entry is still needed, though —
  // even with normal bundling, the dynamically-imported worker file itself
  // is invisible to the tracer and must be forced into the deployment.
  outputFileTracingIncludes: {
    "/api/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
