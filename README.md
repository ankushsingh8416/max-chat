# Max Estates AI Chatbot

An AI chat assistant for [maxestates.in](https://maxestates.in) that answers visitor questions
about projects, pricing, location, RERA details, and news — grounded in a RAG pipeline synced
from the WordPress site's REST API. Built with Next.js (App Router), TypeScript, Tailwind CSS,
Gemini, and Supabase/pgvector.

## How it fits together

```
WordPress REST API  →  scripts/sync-content.ts  →  Supabase (pgvector)
(maxestates.in)         (clean, chunk, embed)         content_chunks table
                                                              │
                                                              ▼
Browser  ──►  ChatWidget  ──►  /api/chat  ──►  vector + structured lookup  ──►  Gemini (streamed)
```

The chat widget itself is **not** a WordPress plugin — it's a small Next.js app deployed
separately (e.g. to Vercel) and embedded into maxestates.in via a one-line `<script>` snippet
that injects an iframe. See [Embedding on WordPress](#embedding-on-wordpress) below.

### A note on what's actually on the live site

The spec this project was built from assumed separate `residential-projects` /
`commercial-projects` / `blogs` post types. Checking the live REST API
(`/wp-json/wp/v2/types`) on 2026-07-03 showed the real structure is different:

- Post types: `post` (`posts`), `page` (`pages`), `project` (`project`), `news_and_media`, `job`.
  There is no separate residential/commercial/blogs post type — `project` covers both, with a
  `category` taxonomy (rest_base `categories`) distinguishing them (e.g. residential-projects,
  commercial-projects, city slugs like gurgaon/delhi).
- `acf` is present on every content item's REST response but comes back as `[]` (empty) — the
  "ACF to REST API" exposure isn't actually populating fields. The scrape fallback in
  [`lib/content/extract.ts`](lib/content/extract.ts) is therefore doing real work, not just a
  safety net — it's the only source of price/location/RERA/amenities today.
- The sync pipeline auto-discovers post types from `/wp-json/wp/v2/types` rather than hardcoding
  the above list, so if editorial adds a new custom post type later, it gets picked up
  automatically (minus a small denylist of WP-internal types in `lib/constants.ts`).

Running the scraper against the live site today, `price` and `possession_date` come back empty
on every project page — that content appears to be injected client-side (a lead-gen
widget/shortcode) rather than present in the static HTML `fetch()` returns. Every sync run logs
a `[extract] Missing fields [...]` warning per page so this is easy to spot; if editorial wants
those fields chatbot-answerable, the durable fix is enabling proper ACF REST exposure for the
`project` post type (Custom Fields → "Show in REST API" per field group), not more scraping.

**Price is unavailable everywhere, including the PDF brochures — confirmed by design, not a bug.**
Checked directly (2026-07-03): the "Price and Payment Plan" page of the 222 Rajpur brochure PDF
contains real extractable text for the payment *schedule* (10% on booking, 85% within 45 days,
etc.) but the actual base price figure is a 931×1395px **image**, not text — `pdf-parse` (or any
text extractor) cannot see numbers baked into a picture. The website does the same thing via a
client-side widget. This looks like a deliberate choice across the whole site (drive inquiries
rather than publish raw numbers), not an extraction gap to keep chasing — the chatbot correctly
says it doesn't have pricing and points users to contact the team, which is the right behavior
here. The only way to actually recover these numbers would be OCR on the brochure's price-table
images, which was deliberately not built (added complexity/cost for uncertain accuracy against a
likely-intentional business decision) — revisit only if editorial explicitly wants pricing
chatbot-answerable and is willing to publish it as real text somewhere.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run [`sql/schema.sql`](sql/schema.sql) — it enables `pgvector`,
   creates `content_chunks`, `sync_logs`, `chat_analytics`, the `match_content_chunks` RPC
   function, and Row Level Security policies (public read-only on `content_chunks`, all writes
   restricted to the service role key).
3. From Project Settings → API, copy the **Project URL**, **anon public key**, and
   **service_role key** (keep the last one secret).

## 2. Get a Gemini API key

Create a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). One
key is used both for chat (`gemini-2.5-flash`) and embeddings (`gemini-embedding-001`,
truncated to 768 dimensions to match the Supabase schema).

Model names drift over time as Google retires/renames them — the spec this project started
from named `gemini-2.0-flash` and `text-embedding-004`, but by 2026-07-03 the first had lost
free-tier quota and the second had been removed entirely. If `/api/chat` or `npm run sync`
starts failing with a 404 "model not found" or a 429 with `limit: 0`, run this against your key
to see what's currently available and update `GEMINI_CHAT_MODEL`/`GEMINI_EMBEDDING_MODEL` in
`lib/constants.ts` accordingly:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
```

### Multiple keys / automatic failover

Free-tier Gemini quotas are tight enough (see above) that a single key can realistically run dry
during normal use, not just heavy testing. Set `GEMINI_API_KEYS` (comma-separated) to configure a
pool — `lib/gemini/key-pool.ts` automatically rotates to the next key whenever one hits a 429
(quota/rate limit) or an invalid/revoked-key error (401/403), for both embeddings and chat:

- **Embeddings** (bulk sync and chat-time retrieval): rotation happens *within* the same call —
  `lib/gemini/embeddings.ts` tries every key in the pool before giving up, so a single request
  transparently recovers if the first key it tries is out of quota.
- **Chat generation**: the active key is picked fresh per request. A key that fails mid-stream
  still surfaces as an error to that one request (a streaming response can't be silently retried
  once bytes are flowing to the client), but it's marked exhausted for ~24h so every request
  after it automatically skips to a working key.

`GEMINI_API_KEY` alone still works as a single-key setup — `GEMINI_API_KEYS` is additive/optional.

## 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and a random `CRON_SECRET` (e.g. `openssl rand -hex 32`).

`SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are read only in server-only code (the sync
pipeline, and the API routes under `app/api/`) — they are never bundled into client JS. Only
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are exposed to the browser, which
is safe by design since the anon key is read-only under RLS.

## 4. Install dependencies and run an initial sync

```bash
npm install
npm run sync:full
```

`sync:full` does a complete crawl of every discovered post type and populates
`content_chunks` from scratch — use this the first time, and any time you want to rebuild the
index. `npm run sync` (no `--full`) does an incremental sync: it fetches only pages modified
since the last successful run for ordinary content, but **always** does a full re-check of
`project`-type content, since price/availability can change without WordPress updating its
`modified` timestamp.

Watch the console output — it prints colored progress per post type plus a final report (pages
synced/skipped/failed, retry count, elapsed time), and also writes a row to the `sync_logs`
table for later auditing.

### Embedding quota, retries, and resuming an interrupted sync

Gemini's free tier caps embedding requests **per day** (observed: 1000 requests/day for
`gemini-embedding-001`), not just per minute — a full crawl of a few hundred WordPress pages can
burn through that in one run. The sync pipeline (`lib/sync/`) is built to handle this without
losing work:

- **Batching**: chunks are embedded in batches (`EMBEDDING_BATCH_SIZE`, default 20 texts/request)
  rather than one request per chunk, since the quota counts *requests*, not chunks — fewer,
  larger requests go further against a daily cap.
- **Pacing + retry**: every embedding call passes through a shared rate limiter
  (`EMBEDDING_DELAY_MS`) and concurrency queue (`EMBEDDING_CONCURRENCY`, default 1 — raise it
  later once you're on a paid tier that supports concurrent calls). On a 429/500/503, it retries
  with truncated exponential backoff (`MAX_EMBED_RETRIES`, `MAX_BACKOFF_MS`) — but if Google's
  error response includes its own suggested wait (`retryDelay`), that's used instead of the
  calculated backoff, since the API is telling you exactly how long the limit needs to clear.
- **Resume checkpoint**: after every page, progress is saved to a local `.sync-checkpoint.json`
  (path configurable via `CHECKPOINT_FILE`). If the daily quota cuts a run off partway through
  (or you just Ctrl+C it), re-running `npm run sync:full` **skips everything already embedded**
  and continues from where it stopped — it does not restart from page one. Use
  `npm run sync:full -- --reset-checkpoint` to force a clean re-embed of everything instead (e.g.
  after changing the chunking logic or embedding model).
- **Per-page failure isolation**: one page's embedding failure never aborts the run — it's
  logged, checkpointed as `failed` (so it's retried on the next run, unlike successfully-done
  pages), and the crawl continues to the next page.

**This checkpoint only helps the local CLI path.** `/api/sync` (the Vercel Cron route) runs in a
fresh, largely read-only serverless filesystem on every invocation, so there's nothing to resume
from between cron runs — checkpoint writes there silently no-op (see
`lib/sync/checkpoint.ts`). For a large initial backfill, run `npm run sync:full` from your own
machine (where the checkpoint persists across interrupted runs and days), and let the daily
cron handle the much smaller incremental workload afterward, which should comfortably fit in
free-tier quota.

All of the above is configurable via env vars — see the "Sync pipeline tuning" section of
`.env.example`.

### Content the REST API can't see: page-builder pages and PDFs

Two content sources needed more than a plain REST fetch, both discovered by comparing the WP
REST API's output against the site's actual sitemap (`/page-sitemap.xml`):

- **Page-builder marketing pages** (About, Our Philosophy, Investors, Sustainability, Downloads,
  etc.) have an empty `content.rendered` field via REST — their real content lives in
  shortcodes/widgets the WP content editor never captures. `lib/content/extract.ts`'s
  `extractGenericPageText` scrapes the rendered HTML directly whenever REST content comes back
  under ~200 characters, for **any** post type, not just projects. This runs automatically as
  part of `npm run sync` / `sync:full` — no separate command needed.
- **PDF brochures and reports** (project brochures, sustainability reports, environmental
  clearances) are static files linked from `https://maxestates.in/downloads` — WordPress's REST
  API has no concept of them at all. Run this separately:

  ```bash
  npm run sync:pdfs
  ```

  It scrapes `/downloads` for PDF links (`lib/wp/downloads.ts`), extracts text with `pdf-parse`
  (`lib/content/pdf.ts`), and pushes it through the same chunk/embed/checkpoint pipeline as
  everything else (`post_type: 'pdf'` in `content_chunks`). It's not bundled into `sync:full`
  automatically since PDFs can be long and you may want to control when that quota gets spent —
  run it whenever, it's resumable the same way.

## 5. Run locally

```bash
npm run dev
```

Visit `http://localhost:3000` — the chat bubble is in the bottom-right corner. Try a starter
prompt or ask something like "What's the price of Estate 105?" to see the RAG pipeline in
action.

## 6. Deploy to Vercel

1. Push this repo to GitHub/GitLab/Bitbucket and import it in Vercel, or run `vercel` from the
   CLI.
2. Add all variables from `.env.example` as Vercel project environment variables (Production
   and Preview).
3. Deploy. `vercel.json` already defines a daily cron job (`0 3 * * *`, 3 AM UTC) that hits
   `/api/sync` — Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on cron
   invocations, which `app/api/sync/route.ts` verifies before running. No manual cron setup is
   needed beyond setting the `CRON_SECRET` env var.
4. Trigger the first sync in production once (cron jobs alone won't run until the schedule
   hits): `curl -X POST https://<your-app>.vercel.app/api/sync?full=true -H "Authorization: Bearer <CRON_SECRET>"`.

Cron jobs on Vercel's Hobby plan run at most once a day, which matches the 3 AM schedule here.
If you're on Hobby and want more frequent syncs, trigger `/api/sync` from an external scheduler
(GitHub Actions, cron-job.org, etc.) with the same `Authorization` header instead.

## Embedding on WordPress

The chat UI is served by this Next.js app, not by a WordPress plugin. To put it on
maxestates.in:

1. Deploy this app to Vercel (e.g. `https://max-estates-chat.vercel.app`).
2. On the WordPress site, add this before `</body>` — via your theme's footer, or a plugin like
   "Insert Headers and Footers" / WPCode:

   ```html
   <script src="https://max-estates-chat.vercel.app/embed.js" async></script>
   ```

3. That's it. `public/embed.js` injects a small fixed-position `<iframe>` pointed at this app's
   `/widget` route (which renders just the chat bubble + panel, no site chrome) and resizes that
   iframe between a small closed "bubble" and a full chat panel using `postMessage` — see
   `lib/embed-bridge.ts` for the client side of that handshake. Because the iframe is same-origin
   with the Vercel deployment, `/api/chat` calls from inside it never hit a cross-origin request,
   so no CORS configuration is needed.

If you ever migrate the WordPress frontend to Next.js directly, you can instead mount
`<ChatWidget />` (from `components/ChatWidget.tsx`) directly in your root layout — that's how
`app/page.tsx` in this repo demos it standalone.

## Project structure

```
app/
  api/chat/route.ts      streaming chat endpoint (RAG + Gemini, rate-limited)
  api/sync/route.ts       protected endpoint for the Vercel Cron job
  widget/page.tsx         bare host page for the WordPress iframe embed
  page.tsx                 demo landing page with the widget mounted directly
components/
  ChatWidget.tsx           chat panel: useChat, sessionStorage persistence, a11y, embed mode
  ChatBotButton.tsx        floating launcher button
  ChatErrorBoundary.tsx    isolates widget crashes from the rest of the page
  MarkdownMessage.tsx      renders bot responses as markdown with clickable links
  TypingIndicator.tsx      animated "..." while the model is responding
lib/
  wp/
    client.ts                 WordPress REST client (pagination, post-type discovery)
    downloads.ts                scrapes /downloads for PDF links (not REST-visible content)
  content/
    clean.ts                   HTML-to-text
    extract.ts                  ACF/scrape structured-data extraction + generic page-text fallback
    chunk.ts                    recursive chunking
    pdf.ts                       PDF text extraction (pdf-parse)
  gemini/embeddings.ts      raw gemini-embedding-001 API call + chat-time embedText
  sync/                     bulk-sync-specific hardening (see "Embedding quota..." above)
    retry.ts                  truncated exponential backoff, honors Google's retryDelay
    rate-limiter.ts            minimum spacing between embedding calls
    queue.ts                   concurrency cap (EMBEDDING_CONCURRENCY)
    embedding-service.ts       composes the three above around embeddings.ts for bulk sync
    checkpoint.ts               local resume state (CLI-only, see caveat above)
    logger.ts                   colored CLI output + progress bar
    sync-runner.ts              WP content orchestration: discover → fetch → extract → chunk → embed → save
    pdf-sync.ts                  PDF orchestration, same pipeline shape as sync-runner.ts
  supabase/                 admin (service role) and anon Supabase clients + row types
  rag.ts                    vector + structured retrieval, system prompt construction
  rate-limit.ts             in-memory per-IP rate limiter (chat API, unrelated to sync)
  analytics.ts              anonymized chat_analytics logging
scripts/
  sync-content.ts             CLI entry point (`npm run sync` / `npm run sync:full`)
  sync-pdfs.ts                 CLI entry point (`npm run sync:pdfs`)
  seed-checkpoint-from-supabase.ts   one-time backfill if checkpoint and DB ever drift apart
sql/schema.sql               Supabase schema, RLS policies, match_content_chunks RPC
public/embed.js               WordPress embed snippet
```

## Production notes

- **Rate limiting** is in-memory (`lib/rate-limit.ts`), capped at 15 messages/min per IP. This
  resets per serverless-function instance on Vercel, so it's a soft abuse guard rather than a
  hard global limit — swap in `@upstash/ratelimit` if you need a strict cross-instance cap.
- **Input limits**: messages over 2000 characters are rejected with a 400 before reaching Gemini.
- **Graceful degradation**: if the Supabase vector search fails, `/api/chat` still answers (with
  no retrieved context, so the system prompt instructs the model to say it doesn't have the
  information) rather than hard-failing the request.
- **Error isolation**: `ChatErrorBoundary` means a widget crash renders nothing rather than
  breaking the host page.
- **Analytics**: every question is logged to `chat_analytics` (question text, whether any
  context was found, chunk count, a rough language hint) with no IP or identity captured, to
  spot content gaps over time.
#   m a x - c h a t  
 