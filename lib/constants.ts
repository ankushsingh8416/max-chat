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

// Migrated from Gemini to OpenAI on 2026-07-04. Verified against the live
// API key via GET /v1/models before picking these: gpt-5.4-mini is the
// current mini-tier model (fast/cheap, good enough for RAG-grounded chat);
// text-embedding-3-small is OpenAI's current small embedding model.
export const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-5.4-mini";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
// text-embedding-3-small defaults to 1536 dimensions; truncated to 768 via
// the `dimensions` provider option in lib/openai/embeddings.ts to match the
// existing vector(768) column (sql/schema.sql) — no schema migration needed
// even though the embedding provider changed. NOTE: switching embedding
// models means every previously-synced chunk's vector is now from a
// different embedding space and must be regenerated — run
// `npm run sync:full -- --reset-checkpoint` (and the PDF equivalent) after
// this migration, or search results will silently compare incompatible
// vectors. That reset-checkpoint run also automatically rebuilds the vector
// index afterward (lib/db/maintenance.ts) — confirmed the hard way that
// skipping this leaves the IVFFlat index's clustering trained on the old
// embedding space, which silently drops results for large parts of the
// query space rather than erroring.
export const EMBEDDING_DIMENSIONS = 768;

export const CHUNK_TARGET_TOKENS = 650; // within the requested ~500-800 range
export const CHUNK_OVERLAP_TOKENS = 100;

/**
 * Sync pipeline embedding-request tuning (see lib/sync/). OpenAI's rate
 * limits are tier-based (requests/tokens per minute, scaling with usage
 * history) rather than a small fixed daily cap like Gemini's free tier was —
 * EMBEDDING_BATCH_SIZE still matters (fewer, larger requests use less of the
 * per-minute request-count limit), and EMBEDDING_DELAY_MS/EMBEDDING_CONCURRENCY
 * protect against bursty throttling.
 */
export const EMBEDDING_CONCURRENCY = intFromEnv("EMBEDDING_CONCURRENCY", 1);
export const EMBEDDING_DELAY_MS = intFromEnv("EMBEDDING_DELAY_MS", 4500);
export const EMBEDDING_BATCH_SIZE = intFromEnv("EMBEDDING_BATCH_SIZE", 20);
export const MAX_EMBED_RETRIES = intFromEnv("MAX_EMBED_RETRIES", 5);
export const MAX_BACKOFF_MS = intFromEnv("MAX_BACKOFF_MS", 30_000);
export const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || ".sync-checkpoint.json";

/**
 * Retry budget for the chat-time query embedding (lib/openai/embeddings.ts
 * embedText), deliberately much smaller than the bulk sync's. A live chat
 * request needs to fail in seconds, not patiently wait out a long backoff
 * the way a long-running sync job reasonably can — /api/chat already
 * degrades gracefully to an ungrounded answer on retrieval failure, so
 * failing fast just means the user gets *a* response quickly.
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
// Stricter than RAG_MATCH_THRESHOLD: below this, retrieveContext treats the
// vector search result as "not confident enough" and tries the live
// WordPress-search fallback (lib/rag/live-fallback.ts) before giving up.
export const LIVE_FALLBACK_CONFIDENCE_THRESHOLD = 0.65;

export const CHAT_RATE_LIMIT_MAX = 15;
export const CHAT_RATE_LIMIT_WINDOW_MS = 60_000;

export const MAX_MESSAGE_LENGTH = 2000;

// Admin "upload & train" page (lib/admin/, app/admin/, app/api/admin/) — lets
// the client drag-and-drop documents to add to the knowledge base without a
// code deploy. Tagged with this post_type so it's easy to list/delete
// independently of WordPress-synced content.
export const MANUAL_UPLOAD_POST_TYPE = "manual_upload";
export const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024; // 15MB; also bounded by the hosting platform's request body limit
export const ADMIN_COOKIE_NAME = "admin_token";
// Admin uploads are always injected into the chat context regardless of
// vector similarity to the user's question (see lib/rag.ts) — an admin
// deliberately added this content, often short "always follow this
// instruction" text that won't score well against arbitrary phrasing, so
// treating it like ordinary searched content would silently drop it. Capped
// so a large backlog of uploads can't balloon every request's context.
export const MAX_MANUAL_UPLOAD_CONTEXT_CHUNKS = 30;

// How often the in-process scheduler (lib/scheduler.ts) re-runs the content
// sync automatically. Only takes effect on a long-running server (AWS
// EC2/ECS/Docker, `next start`) — see instrumentation.ts. Vercel's own cron
// (vercel.json) covers the same job when deployed there instead.
export const AUTO_SYNC_CRON_SCHEDULE = process.env.AUTO_SYNC_CRON_SCHEDULE || "0 3 * * *"; // 3 AM daily
