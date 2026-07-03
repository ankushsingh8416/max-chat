import { PDFParse } from "pdf-parse";

export interface FetchedPdf {
  text: string;
  lastModified: string | null;
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

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, lastModified };
  } finally {
    await parser.destroy();
  }
}
