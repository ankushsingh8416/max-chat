import { WP_BASE_URL } from "../constants";
import { extractGenericPageText, extractPageDate } from "../content/extract";
import { fetchRenderedHtml } from "../wp/client";
import { chunkContent } from "../content/chunk";
import { embedBatchRaw } from "../openai/embeddings";
import { deleteChunksBySourceUrl, getStoredLastModified, insertContentChunks } from "../db/content-chunks";
import type { ContentChunkRow, MatchedChunk } from "../db/types";

const LIVE_FALLBACK_TIMEOUT_MS = 12_000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60_000;
const MAX_CANDIDATE_PAGES = 4;
const MIN_EXTRACTED_TEXT_LENGTH = 100;

interface WpSearchResult {
  id: number;
  title: string;
  url: string;
  subtype: string;
}

/**
 * WordPress's own /wp-json/wp/v2/search has the exact same blind spot as
 * REST content.rendered — confirmed directly: it returns zero results for
 * "Ailawadi" and unrelated blog posts for "Head Legal", because it only
 * searches stored post content, not page-builder-rendered widget output
 * (the leadership-team page's team grid, in this case). Since these
 * "who is X" / company-identity questions overwhelmingly land on one of a
 * small set of static pages, fall back to directly re-checking those when
 * WP's search comes up empty, rather than giving up entirely.
 */
const KNOWN_IMPORTANT_PAGES: WpSearchResult[] = [
  { id: -1, title: "Leadership Team", url: `${WP_BASE_URL}/leadership-team`, subtype: "page" },
  { id: -2, title: "About Us", url: `${WP_BASE_URL}/about`, subtype: "page" },
  { id: -3, title: "Investors", url: `${WP_BASE_URL}/investors`, subtype: "page" },
  {
    id: -4,
    title: "Composition of various committees of board of directors",
    url: `${WP_BASE_URL}/composition-of-various-committees-of-board-of-directors`,
    subtype: "page",
  },
];

/**
 * Queries confirmed to return nothing recently aren't retried immediately —
 * protects the live WordPress site from repeated scrape attempts for a
 * question that genuinely has no answer there (confirmed both against WP's
 * own /wp-json/wp/v2/search and this app's index). A simple in-memory Map is
 * enough here: this is a same-process cache for one deployment, not shared
 * state that needs to survive restarts or be consistent across instances.
 */
const negativeCache = new Map<string, number>();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().slice(0, 200);
}

function pruneNegativeCache(): void {
  const now = Date.now();
  for (const [key, expiresAt] of negativeCache) {
    if (expiresAt <= now) negativeCache.delete(key);
  }
}

/** WordPress's own site search — covers posts/pages/projects/news, not PDFs (those are static files, not WP content). */
async function searchWordPress(query: string): Promise<WpSearchResult[]> {
  const url = `${WP_BASE_URL}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATE_PAGES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WordPress search request failed: ${res.status}`);
  return res.json();
}

let syntheticIdCounter = 0;

// Excluded even though they're long enough to look "significant" — the
// company name/domain shows up on nearly every page (footers, source
// citations, "maxestates.in" in body text), so keeping it as a match term
// made almost every candidate page look relevant to almost every query,
// defeating the whole point of filtering.
const GENERIC_TERMS = new Set(["maxestates", "estates", "limited", "group", "please", "information", "details"]);

/** Words worth requiring an overlap on — short/common words would make every chunk "relevant". */
function extractSignificantTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .replace(/[?.,!'"%]/g, "")
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 3 && !GENERIC_TERMS.has(w))
    )
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Requires EVERY term present, matched as a whole word — not just any one of
 * them as a plain substring. Confirmed directly this matters: a plain
 * "contains any term" check let unrelated blog posts through for "who is
 * Head Legal..." because "head" alone appears constantly in ordinary English
 * ("ahead", "headquarters", or just the common word), so almost any
 * long-enough article matched on that one word alone. Requiring every term,
 * as whole words, is far stricter — enough to reliably separate "the page
 * about this specific person/role" from "an article that happens to contain
 * one of these words somewhere."
 */
function containsAllTerms(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`).test(lower));
}

/**
 * Fetches a candidate page fresh, extracts and chunks it, embeds it (via the
 * fast uncapped embedBatchRaw, not the bulk-sync-tuned embedTexts — this is a
 * single ad-hoc call mid-chat-request, not a large batch job that needs
 * quota-conscious pacing), and saves ALL of it into content_chunks exactly
 * like the scheduled sync does — so it's immediately available for every
 * future query, not just this one.
 *
 * Only returns the subset of that page's chunks that actually mention one of
 * the query's significant terms, though — confirmed directly this matters:
 * without it, falling back to KNOWN_IMPORTANT_PAGES injects every chunk from
 * every candidate page (Leadership Team + About + Investors + Board
 * Committees came to 35 chunks for one query), and the 1-2 chunks that
 * actually answered the question got lost in that noise; the model ended up
 * *less* confident with more (irrelevant) context, not more.
 */
async function fetchAndIndexPage(result: WpSearchResult, terms: string[]): Promise<MatchedChunk[]> {
  const html = await fetchRenderedHtml(result.url);
  const text = extractGenericPageText(html);
  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) return [];

  const chunks = chunkContent(text);
  if (chunks.length === 0) return [];

  const embeddings = await embedBatchRaw(chunks.map((c) => c.text));

  // Prefer the page's own article:modified_time/published_time meta tags
  // (real WordPress data) over "now" — confirmed directly that stamping a
  // re-scraped page with the current timestamp corrupts its real publish
  // date the moment it's ever re-indexed this way, breaking "when was this
  // published" for that page from then on even though the original
  // REST-based sync had it right. Falls back to whatever was already stored
  // (if this page has been synced before) rather than guessing, and only
  // uses "now" as a last resort for a page with no date info anywhere.
  const lastModified =
    extractPageDate(html) ?? (await getStoredLastModified(result.url)) ?? new Date().toISOString();

  const rows: ContentChunkRow[] = chunks.map((chunk, i) => ({
    source_url: result.url,
    title: result.title,
    post_type: result.subtype || "page",
    chunk_text: chunk.text,
    chunk_index: chunk.chunkIndex,
    structured_data: null,
    embedding: embeddings[i],
    last_modified: lastModified,
  }));

  await deleteChunksBySourceUrl(result.url);
  await insertContentChunks(rows);

  const matched = rows.map((row) => ({
    id: -(++syntheticIdCounter), // synthetic: freshly inserted this request, real id isn't needed for context building
    source_url: row.source_url,
    title: row.title,
    post_type: row.post_type,
    chunk_text: row.chunk_text,
    structured_data: null,
    last_modified: row.last_modified,
    similarity: 1,
  }));

  if (terms.length === 0) return matched;
  return matched.filter((c) => containsAllTerms(c.chunk_text, terms));
}

/**
 * Fetches/extracts/embeds/saves each candidate page concurrently — they're
 * independent, so there's no reason to pay for one page's latency at a time
 * when the fallback is already on the chat response's critical path.
 */
async function tryCandidates(candidates: WpSearchResult[], terms: string[]): Promise<MatchedChunk[]> {
  const settled = await Promise.allSettled(
    candidates.slice(0, MAX_CANDIDATE_PAGES).map((c) => fetchAndIndexPage(c, terms))
  );

  const chunks: MatchedChunk[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      chunks.push(...outcome.value);
    } else {
      console.error(`[live-fallback] failed to index ${candidates[i].url}: ${(outcome.reason as Error).message}`);
    }
  });
  return chunks;
}

async function runFallback(query: string): Promise<MatchedChunk[]> {
  const terms = extractSignificantTerms(query);
  const wpResults = await searchWordPress(query).catch(() => [] as WpSearchResult[]);

  let chunks = wpResults.length > 0 ? await tryCandidates(wpResults, terms) : [];

  // WP search coming back empty is one failure mode; the other — confirmed
  // directly on "who is Head Legal Max Estates Limited" — is it returning
  // real results that are just irrelevant (random blog posts that happen to
  // share a word), which all get filtered out by the term-overlap check
  // above and leave nothing usable. Either way, the fix is the same: also
  // try the known page-builder-heavy pages before giving up entirely.
  if (chunks.length === 0) {
    chunks = await tryCandidates(KNOWN_IMPORTANT_PAGES, terms);
  }

  return chunks;
}

/**
 * Self-healing retrieval fallback: when the existing index doesn't confidently
 * answer a question (see LIVE_FALLBACK_CONFIDENCE_THRESHOLD in lib/rag.ts),
 * this searches the live website directly, indexes whatever it finds on the
 * spot, and returns it for immediate use in the current response — closing
 * the gap between "content changed/was missed" and "next scheduled sync"
 * without the user ever needing to know a gap existed.
 *
 * Bounded by a timeout so a slow/unresponsive site can't hang a chat request
 * indefinitely — on timeout or any failure, returns an empty array and the
 * caller falls back to its normal "I don't have this, let me connect you"
 * behavior.
 */
export async function attemptLiveFallback(query: string): Promise<MatchedChunk[]> {
  pruneNegativeCache();

  const key = normalizeQuery(query);
  const cachedUntil = negativeCache.get(key);
  if (cachedUntil && cachedUntil > Date.now()) return [];

  try {
    const timeout = new Promise<MatchedChunk[]>((_, reject) =>
      setTimeout(() => reject(new Error("live fallback timed out")), LIVE_FALLBACK_TIMEOUT_MS)
    );
    const chunks = await Promise.race([runFallback(query), timeout]);
    if (chunks.length === 0) negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
    return chunks;
  } catch (err) {
    console.error(`[live-fallback] failed for "${query}": ${(err as Error).message}`);
    negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
    return [];
  }
}
