import { randomUUID } from "crypto";
import { extractPdfTextFromBuffer } from "../content/pdf";
import { extractDocxText } from "../content/docx";
import { chunkContent } from "../content/chunk";
import { embedTexts } from "../sync/embedding-service";
import { insertContentChunks } from "../db/content-chunks";
import { MANUAL_UPLOAD_POST_TYPE } from "../constants";
import type { ContentChunkRow } from "../db/types";

export interface ProcessUploadResult {
  sourceUrl: string;
  title: string;
  chunkCount: number;
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx + 1).toLowerCase();
}

async function extractText(filename: string, buffer: Buffer): Promise<string> {
  switch (getExtension(filename)) {
    case "pdf":
      return extractPdfTextFromBuffer(buffer);
    case "docx":
      return extractDocxText(buffer);
    case "txt":
      return buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file type — only PDF, DOCX, and TXT are supported`);
  }
}

/**
 * Processes a manually-uploaded document (admin "train the bot" page): extracts
 * text, chunks it, embeds it with OpenAI, and saves it into the same
 * content_chunks table the WordPress sync writes to — so it's picked up by
 * RAG retrieval exactly like any other content. Each upload gets a synthetic
 * `upload://<uuid>` source_url so it can be looked up/deleted independently of
 * the filename (filenames aren't guaranteed unique across uploads).
 */
export async function processUpload(filename: string, buffer: Buffer): Promise<ProcessUploadResult> {
  const text = await extractText(filename, buffer);
  const chunks = chunkContent(text);
  if (chunks.length === 0) {
    throw new Error("No extractable text found in this file");
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text));
  const sourceUrl = `upload://${randomUUID()}`;

  const rows: ContentChunkRow[] = chunks.map((chunk, i) => ({
    source_url: sourceUrl,
    title: filename,
    post_type: MANUAL_UPLOAD_POST_TYPE,
    chunk_text: chunk.text,
    chunk_index: chunk.chunkIndex,
    structured_data: null,
    embedding: embeddings[i],
    last_modified: new Date().toISOString(),
  }));

  await insertContentChunks(rows);

  return { sourceUrl, title: filename, chunkCount: rows.length };
}
