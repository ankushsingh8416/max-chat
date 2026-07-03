export const WP_BASE_URL = process.env.WP_BASE_URL || "https://maxestates.in";
export const WP_API_BASE = `${WP_BASE_URL}/wp-json/wp/v2`;

/**
 * WordPress post types that are internal/system types and should never be
 * synced as chatbot content, even though they appear in /wp-json/wp/v2/types.
 */
export const WP_TYPE_DENYLIST = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_global_styles",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
  "ig_es_campaign", // internal email campaign type, not customer-facing content
]);

/**
 * Post type rest_base values that represent real-estate project listings.
 * These get: (a) full re-sync every run regardless of `modified` date, since
 * price/availability can change without WP bumping modified_gmt, and
 * (b) a direct structured_data lookup path in RAG retrieval, not just vector
 * search, since price/RERA/location are factual lookups.
 *
 * Verified against the live site on 2026-07-03: the site exposes a single
 * `project` custom post type (rest_base "project") with a `category`
 * taxonomy distinguishing residential vs commercial vs city — there are no
 * separate residential-projects/commercial-projects post types.
 */
export const PROJECT_TYPE_SLUGS = new Set(["project"]);

// `gemini-2.0-flash` and `text-embedding-004` (the models named in the original spec)
// have since been retired / lost free-tier quota — verified 2026-07-03 against the
// live API key via ListModels: text-embedding-004 no longer exists at all, and
// gemini-2.0-flash returns `limit: 0` on the free tier. gemini-2.5-flash and
// gemini-embedding-001 are the current equivalents with working free-tier access.
export const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
// gemini-embedding-001 defaults to 3072 dimensions; truncated to 768 via
// outputDimensionality in lib/gemini/embeddings.ts to match the Supabase column.
export const EMBEDDING_DIMENSIONS = 768;

export const CHUNK_TARGET_TOKENS = 650; // within the requested ~500-800 range
export const CHUNK_OVERLAP_TOKENS = 100;

/**
 * Sync pipeline embedding-request tuning (see lib/sync/). Google's free-tier
 * embedding quota is a hard DAILY request-count cap (observed: 1000
 * requests/day for gemini-embedding-001), not just a per-minute rate — so
 * EMBEDDING_BATCH_SIZE (fewer, larger requests) matters more than pacing for
 * fitting a large corpus in one day. EMBEDDING_DELAY_MS/EMBEDDING_CONCURRENCY
 * mainly protect against bursty per-minute throttling.
 */
export const EMBEDDING_CONCURRENCY = intFromEnv("EMBEDDING_CONCURRENCY", 1);
export const EMBEDDING_DELAY_MS = intFromEnv("EMBEDDING_DELAY_MS", 4500);
export const EMBEDDING_BATCH_SIZE = intFromEnv("EMBEDDING_BATCH_SIZE", 20);
export const MAX_EMBED_RETRIES = intFromEnv("MAX_EMBED_RETRIES", 5);
export const MAX_BACKOFF_MS = intFromEnv("MAX_BACKOFF_MS", 30_000);
export const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || ".sync-checkpoint.json";

/**
 * Retry budget for the chat-time query embedding (lib/gemini/embeddings.ts
 * embedText), deliberately much smaller than the bulk sync's. A live chat
 * request needs to fail in seconds, not patiently wait out a Google-supplied
 * retryDelay the way a long-running sync job reasonably can — /api/chat
 * already degrades gracefully to an ungrounded answer on retrieval failure,
 * so failing fast just means the user gets *a* response quickly.
 */
export const CHAT_EMBED_MAX_RETRIES = intFromEnv("CHAT_EMBED_MAX_RETRIES", 1);
export const CHAT_EMBED_MAX_BACKOFF_MS = intFromEnv("CHAT_EMBED_MAX_BACKOFF_MS", 1500);

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const RAG_MATCH_COUNT = 8;
export const RAG_MATCH_THRESHOLD = 0.55;

export const CHAT_RATE_LIMIT_MAX = 15;
export const CHAT_RATE_LIMIT_WINDOW_MS = 60_000;

export const MAX_MESSAGE_LENGTH = 2000;

// Contact form (lead capture) — stricter than chat since each submission is
// meant to reach a human, not just generate a reply.
export const CONTACT_RATE_LIMIT_MAX = 5;
export const CONTACT_RATE_LIMIT_WINDOW_MS = 10 * 60_000; // 10 minutes
