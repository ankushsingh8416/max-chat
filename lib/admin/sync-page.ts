import { createHash } from "crypto";
import * as cheerio from "cheerio";
import { fetchRenderedHtml } from "../wp/client";
import { extractGenericPageText } from "../content/extract";
import { chunkContent } from "../content/chunk";
import { embedBatchRaw } from "../openai/embeddings";
import { deleteChunksBySourceUrl, getContentHash, insertContentChunks } from "../db/content-chunks";
import { WP_BASE_URL } from "../constants";
import type { ContentChunkRow } from "../db/types";

function inferPostType(url: string): string {
  if (url.includes("/news_and_media/")) return "news_and_media";
  if (url.includes("/residential-projects/") || url.includes("/commercial-projects/") || url.includes("/project/")) {
    return "project";
  }
  if (url.includes("/job/")) return "job";
  return "page";
}

function extractTitle(html: string): string {
  const $ = cheerio.load(html);
  return (
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    "(untitled)"
  );
}

export interface SyncPageResult {
  sourceUrl: string;
  title: string;
  chunkCount: number;
  changed: boolean;
}

/**
 * Admin-triggered single-page sync (see /admin's "Sync a specific page"
 * tool): given any maxestates.in URL, scrape it fresh, chunk + embed + save
 * it — for a page the scheduled sync hasn't reached yet, or to force-refresh
 * one page right now without waiting for/running a full re-sync.
 *
 * Domain is checked every time this runs, not just once — re-syncing the
 * same URL re-validates it against WP_BASE_URL exactly like a first-time
 * sync would, so this can never be used to pull an arbitrary external site
 * into the chatbot's knowledge base regardless of how it's invoked.
 *
 * Content-hashed like the scheduled sync (lib/sync/sync-runner.ts): if the
 * freshly-scraped text is identical to what's already stored, this is a
 * no-op (no wasted embedding call); if it differs, old chunks are replaced
 * with the newly-scraped ones.
 */
export async function syncSinglePage(url: string): Promise<SyncPageResult> {
  const trimmed = url.trim();
  if (!trimmed.startsWith(WP_BASE_URL)) {
    throw new Error(`Only pages on ${WP_BASE_URL} can be synced here.`);
  }

  const html = await fetchRenderedHtml(trimmed);
  const title = extractTitle(html);
  const text = extractGenericPageText(html);
  if (!text || text.length < 50) {
    throw new Error("No meaningful content could be extracted from this page.");
  }

  const chunks = chunkContent(text);
  if (chunks.length === 0) {
    throw new Error("Page content couldn't be split into chunks.");
  }

  const newHash = createHash("sha256")
    .update(chunks.map((c) => c.text).join(" "))
    .digest("hex");
  const existingHash = await getContentHash(trimmed);
  const changed = existingHash !== newHash;

  if (changed) {
    const embeddings = await embedBatchRaw(chunks.map((c) => c.text));
    const lastModified = new Date().toISOString();

    const rows: ContentChunkRow[] = chunks.map((chunk, i) => ({
      source_url: trimmed,
      title,
      post_type: inferPostType(trimmed),
      chunk_text: chunk.text,
      chunk_index: chunk.chunkIndex,
      structured_data: null,
      embedding: embeddings[i],
      last_modified: lastModified,
      content_hash: newHash,
    }));

    await deleteChunksBySourceUrl(trimmed);
    await insertContentChunks(rows);
  }

  return { sourceUrl: trimmed, title, chunkCount: chunks.length, changed };
}
