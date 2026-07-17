import { PDFParse } from "pdf-parse";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * pdfjs-dist (used internally by pdf-parse) resolves its worker script with
 * a path relative to its own module location at runtime
 * (`import(this.workerSrc)`, where workerSrc defaults to "./pdf.worker.mjs")
 * — a dynamic, non-literal import that bundlers can't rewrite, so it breaks
 * the moment the importing module gets relocated by any bundler (Next dev's
 * chunking, Vercel's production bundle, etc.), regardless of build target.
 * Pointing it at an absolute, explicitly-resolved path sidesteps that
 * guesswork entirely. `process.cwd()` is the deployment root both locally
 * and on Vercel, where next.config.ts's `outputFileTracingIncludes` ensures
 * this exact file is present in the production bundle.
 */
PDFParse.setWorker(
  pathToFileURL(path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href
);

export interface FetchedPdf {
  text: string;
  lastModified: string | null;
}

/** Extracts plain text from an in-memory PDF buffer — shared by the URL-based fetch below and admin uploads. */
export async function extractPdfTextFromBuffer(buffer: Uint8Array | Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

/**
 * Downloads a PDF and extracts its plain text. Used for brochures/reports
 * linked from https://maxestates.in/downloads, which the WordPress REST API
 * has no visibility into at all (they're static files, not posts/pages).
 */
export async function extractPdfText(url: string): Promise<FetchedPdf> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PDF ${url} (${res.status})`);

  const lastModified = res.headers.get("last-modified");
  const buffer = new Uint8Array(await res.arrayBuffer());
  const text = await extractPdfTextFromBuffer(buffer);
  return { text, lastModified };
}
