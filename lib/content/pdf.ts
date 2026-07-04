import { PDFParse } from "pdf-parse";

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
