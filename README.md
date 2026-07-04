# Max Estates AI Chatbot

An AI chat assistant for [maxestates.in](https://maxestates.in) that answers visitor questions
about projects, pricing, location, RERA details, and news — grounded in a RAG pipeline synced
from the WordPress site's REST API. Built with Next.js (App Router), TypeScript, Tailwind CSS,
OpenAI, and plain Postgres/pgvector (portable to AWS RDS or any other standard Postgres host —
no vendor-specific database client). Includes an admin page for uploading extra documents
straight into the knowledge base, and an optional in-process scheduler that keeps content fresh
automatically on a persistent server deployment (e.g. AWS).

## How it fits together

```
WordPress REST API  →  scripts/sync-content.ts  →  Postgres (pgvector)
(maxestates.in)         (clean, chunk, embed)         content_chunks table
                                                              ▲        │
                                              /admin upload ──┘        ▼
Browser  ──►  ChatWidget  ──►  /api/chat  ──►  vector + structured lookup  ──►  OpenAI (streamed)
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

## 1. Set up Postgres

This app talks to Postgres directly over the standard wire protocol (via the `pg` package,
`lib/db/`) rather than through a hosted vendor's client SDK — so any Postgres instance with the
`vector` extension works, including AWS RDS for PostgreSQL, a self-hosted box/Docker container, or
Supabase's own direct connection string.

1. Provision a Postgres instance. On AWS, that's **RDS for PostgreSQL** (16.x or newer recommended
   — pgvector ships as an available extension there): create the instance, note its endpoint, and
   make sure its security group allows inbound connections from wherever this app runs.
2. Run [`sql/schema.sql`](sql/schema.sql) against it — it enables the `vector` extension, creates
   `content_chunks`, `sync_logs`, `chat_analytics`, and the `match_content_chunks` SQL function
   used for cosine-similarity search:
   ```bash
   psql "$DATABASE_URL" -f sql/schema.sql
   ```
3. Build your connection string: `postgres://<user>:<password>@<host>:5432/<dbname>` — this is
   `DATABASE_URL` in the next step. AWS RDS requires TLS by default, which this app enables
   automatically (see `lib/db/pool.ts`); set `DATABASE_SSL=disable` only for a local, unencrypted
   Postgres instance.

**Already have data in Supabase and want to migrate it to AWS RDS later without losing anything?**
Supabase projects are themselves just Postgres — grab the direct connection string from
Project Settings → Database → Connection string, point `DATABASE_URL` at it to keep the app
running unchanged, then `pg_dump`/`pg_restore` (or `aws dms`) that data into RDS whenever it's
provisioned — no code changes needed either way, just swap the env var.

## 2. Get an OpenAI API key

Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). One key is
used both for chat (`gpt-5.4-mini`) and embeddings (`text-embedding-3-small`, truncated to 768
dimensions via the `dimensions` provider option to match the `vector(768)` column in
`sql/schema.sql`).

Model names drift over time as providers retire/rename them — this project migrated from Gemini
to OpenAI on 2026-07-04, verifying `gpt-5.4-mini` and `text-embedding-3-small` were live against
the API right before switching. If `/api/chat` or `npm run sync` starts failing with a 404
"model not found" or a 429, run this against your key to see what's currently available and
update `OPENAI_CHAT_MODEL`/`OPENAI_EMBEDDING_MODEL` in `lib/constants.ts` accordingly:

```bash
curl "https://api.openai.com/v1/models" -H "Authorization: Bearer $OPENAI_API_KEY"
```

### Multiple keys / automatic failover

A single key can hit a rate limit or run out of billing quota during normal use, not just heavy
testing. Set `OPENAI_API_KEYS` (comma-separated) to configure a pool —
`lib/openai/key-pool.ts` automatically rotates to the next key whenever one hits a 429
(quota/rate limit) or an invalid/revoked-key error (401/403), for both embeddings and chat:

- **Embeddings** (bulk sync and chat-time retrieval): rotation happens *within* the same call —
  `lib/openai/embeddings.ts` tries every key in the pool before giving up, so a single request
  transparently recovers if the first key it tries is out of quota.
- **Chat generation**: the active key is picked fresh per request. A key that fails mid-stream
  still surfaces as an error to that one request (a streaming response can't be silently retried
  once bytes are flowing to the client), but it's marked exhausted for ~24h so every request
  after it automatically skips to a working key.

`OPENAI_API_KEY` alone still works as a single-key setup — `OPENAI_API_KEYS` is additive/optional.

## 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `OPENAI_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`, and a random `CRON_SECRET`
(e.g. `openssl rand -hex 32`).

Every one of these is read only in server-only code (the sync pipeline, and the API routes under
`app/api/`) — none of them are ever bundled into client JS. The browser never talks to Postgres
directly (unlike the old Supabase setup, which exposed a public anon key to the client for
read-only RPC calls) — every database access goes through a Next.js API route first, which is why
there's no separate "public" vs "service" key split anymore, just one `DATABASE_URL`.

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

OpenAI rate-limits embedding requests **per minute** (requests and tokens), and a low-tier account
can also hit a hard billing/plan quota — a full crawl of a few hundred WordPress pages can still
take a while to get through cleanly. The sync pipeline (`lib/sync/`) is built to handle this
without losing work:

- **Batching**: chunks are embedded in batches (`EMBEDDING_BATCH_SIZE`, default 20 texts/request)
  rather than one request per chunk, since the limit counts *requests*, not chunks — fewer,
  larger requests go further against a per-minute cap.
- **Pacing + retry**: every embedding call passes through a shared rate limiter
  (`EMBEDDING_DELAY_MS`) and concurrency queue (`EMBEDDING_CONCURRENCY`, default 1 — raise it
  later once you're on a tier that supports concurrent calls). On a 429/500/503, it retries
  with truncated exponential backoff (`MAX_EMBED_RETRIES`, `MAX_BACKOFF_MS`) — but if OpenAI's
  error response includes its own suggested wait (a `Retry-After` header), that's used instead of
  the calculated backoff, since the API is telling you exactly how long the limit needs to clear.
- **Resume checkpoint**: after every page, progress is saved to a local `.sync-checkpoint.json`
  (path configurable via `CHECKPOINT_FILE`). If the daily quota cuts a run off partway through
  (or you just Ctrl+C it), re-running `npm run sync:full` **skips everything already embedded**
  and continues from where it stopped — it does not restart from page one. Use
  `npm run sync:full -- --reset-checkpoint` to force a clean re-embed of everything instead (e.g.
  after changing the chunking logic or embedding model).
- **Per-page failure isolation**: one page's embedding failure never aborts the run — it's
  logged, checkpointed as `failed` (so it's retried on the next run, unlike successfully-done
  pages), and the crawl continues to the next page.

**This checkpoint only helps where the filesystem persists between runs.** On Vercel, `/api/sync`
runs in a fresh, largely read-only serverless filesystem on every invocation, so there's nothing
to resume from between cron runs — checkpoint writes there silently no-op (see
`lib/sync/checkpoint.ts`). For a large initial backfill on Vercel, run `npm run sync:full` from
your own machine instead (where the checkpoint persists across interrupted runs and days), and let
the daily cron handle the much smaller incremental workload afterward. On a persistent server
deployment (AWS EC2/ECS/Docker via `next start`), the checkpoint file lives on that server's own
disk and persists across scheduled runs too — see [Automatic syncing](#automatic-syncing) below.

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

## 7. Deploy to AWS (or any persistent server)

If you're hosting on AWS instead of Vercel — EC2, ECS/Fargate, Elastic Beanstalk, or a plain
Docker container — this is a normal long-running Node process, not a serverless function, which
changes two things for the better:

1. **Build and run it like any Node app**:
   ```bash
   npm install
   npm run build
   npm start
   ```
   Set every variable from `.env.example` in that environment (the container's env, an ECS task
   definition, an EC2 instance's environment, etc.) the same way you would on Vercel.
2. **Point `DATABASE_URL` at your RDS instance** (see [Set up Postgres](#1-set-up-postgres)) —
   ideally in the same VPC as wherever the app runs, so traffic never leaves AWS's network.
3. **`vercel.json`'s cron config does nothing here** — it's a Vercel-specific file. See
   [Automatic syncing](#automatic-syncing) below for how content stays fresh on this kind of
   deployment instead.

## Automatic syncing

There are two independent mechanisms, and which one applies depends on how you deployed:

- **On Vercel**: `vercel.json` defines a daily Cron Job that hits `/api/sync` (see
  [Deploy to Vercel](#6-deploy-to-vercel) above). This is the only option there, since Vercel
  functions don't stay running between requests — there's no process to schedule work "from
  inside."
- **On a persistent server (AWS EC2/ECS/Docker, or anywhere else `next start` keeps running)**:
  `instrumentation.ts` starts an in-process scheduler (`lib/scheduler.ts`, built on `node-cron`)
  the moment the server boots. It re-runs an incremental content sync **and** a PDF sync once a
  day by default (`AUTO_SYNC_CRON_SCHEDULE` in `.env.example`, cron syntax, defaults to
  `0 3 * * *`) — no external cron infrastructure, no manual `npm run sync` needed after the first
  deploy. Because the server's disk persists across those scheduled runs (unlike Vercel's
  serverless filesystem), the local checkpoint (`lib/sync/checkpoint.ts`) works exactly the way it
  does when you run the CLI by hand, so repeated runs stay cheap.
  - This only starts once you actually deploy this way — running `npm run dev`/`npm start` on your
    own machine also starts it, so don't be surprised by a sync kicking off at 3 AM local time if
    you leave a dev server running overnight.
  - `/api/sync` (protected by `CRON_SECRET`) still works on this deployment too, for a manual
    trigger — the scheduler doesn't replace it, it just means you don't have to remember to hit it
    yourself every day.

Either way, run an initial `npm run sync:full` once after your first deployment/migration — both
mechanisms only handle the *ongoing* incremental sync, not the first backfill.

## Admin: train the assistant with your own documents

Beyond the WordPress sync, `/admin` is a small password-gated page for adding extra documents to
the knowledge base directly — useful for content that doesn't live on the website at all (internal
FAQs, a one-off announcement, a document a teammate wants the bot to know about right away).

1. Set `ADMIN_PASSWORD` in your environment (see `.env.example`) — a long random value, not
   something guessable.
2. Visit `/admin` and sign in with that password. The login sets an httpOnly cookie (7-day expiry)
   so you don't have to re-enter it on every visit.
3. Drag and drop a **PDF, Word (.docx), or plain text (.txt)** file onto the page, or click it to
   browse. Behind the scenes (`lib/uploads/process-upload.ts`) it's extracted to plain text
   (`lib/content/pdf.ts` / `lib/content/docx.ts`), chunked and embedded the same way WordPress
   content is (`lib/content/chunk.ts`, `lib/openai/embeddings.ts`), and saved into the same
   `content_chunks` table tagged `post_type: 'manual_upload'` — so it's immediately searchable by
   the chatbot alongside everything else, no separate sync step needed.
4. The page lists every document uploaded this way, with a **Remove** button that deletes all of
   that document's chunks from the database — instant, no trace left behind.

This is entirely separate from the WordPress sync pipeline: uploaded documents are never touched
by `npm run sync` and won't disappear if WordPress content changes.

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
  api/chat/route.ts      streaming chat endpoint (RAG + OpenAI, rate-limited)
  api/sync/route.ts       protected endpoint for the Vercel Cron job / manual trigger
  api/admin/
    login/route.ts           sets the admin session cookie
    logout/route.ts           clears it
    upload/route.ts            receives a file, runs it through lib/uploads/process-upload.ts
    docs/route.ts               lists uploaded documents
    docs/[docId]/route.ts        deletes one uploaded document's chunks
  admin/page.tsx           password-gated "train the assistant" page
  widget/page.tsx         bare host page for the WordPress iframe embed
  page.tsx                 demo landing page with the widget mounted directly
components/
  ChatWidget.tsx           chat panel: useChat, sessionStorage persistence, a11y, embed mode
  ChatBotButton.tsx        floating launcher button
  ChatErrorBoundary.tsx    isolates widget crashes from the rest of the page
  MarkdownMessage.tsx      renders bot responses as markdown with clickable links
  TypingIndicator.tsx      animated "..." while the model is responding
  admin/
    AdminLoginForm.tsx         password form, posts to /api/admin/login
    UploadDashboard.tsx         drag-and-drop upload + trained-docs list
lib/
  wp/
    client.ts                 WordPress REST client (pagination, post-type discovery)
    downloads.ts                scrapes /downloads for PDF links (not REST-visible content)
  content/
    clean.ts                   HTML-to-text
    extract.ts                  ACF/scrape structured-data extraction + generic page-text fallback
    chunk.ts                    recursive chunking
    pdf.ts                       PDF text extraction (pdf-parse), URL- and buffer-based
    docx.ts                       DOCX text extraction (mammoth), for admin uploads
  openai/
    key-pool.ts                multi-key rotation/failover pool (embeddings + chat)
    embeddings.ts               raw text-embedding-3-small API call + chat-time embedText
    chat-failover.ts             buffers a chat generation, retries on the next key on failure
  sync/                     bulk-sync-specific hardening (see "Embedding quota..." above)
    retry.ts                  truncated exponential backoff, honors OpenAI's Retry-After header
    rate-limiter.ts            minimum spacing between embedding calls
    queue.ts                   concurrency cap (EMBEDDING_CONCURRENCY)
    embedding-service.ts       composes the three above around embeddings.ts for bulk sync
    checkpoint.ts               local resume state, see caveats above
    logger.ts                   colored CLI output + progress bar
    sync-runner.ts              WP content orchestration: discover → fetch → extract → chunk → embed → save
    pdf-sync.ts                  PDF orchestration, same pipeline shape as sync-runner.ts
  db/                       plain Postgres access via `pg` — no vendor-specific client
    pool.ts                    connection pool (DATABASE_URL)
    content-chunks.ts           all content_chunks queries: insert/delete, vector search, structured lookups
    sync-logs.ts                 sync_logs read/write
    chat-analytics.ts             chat_analytics insert
    types.ts                      shared row types
  admin/auth.ts             password-cookie check, shared by /admin and /api/admin/*
  uploads/process-upload.ts  admin-upload pipeline: extract → chunk → embed → save
  scheduler.ts              in-process daily auto-sync (AWS/persistent-server deployments only)
  rag.ts                    vector + structured retrieval, system prompt construction
  rate-limit.ts             in-memory per-IP rate limiter (chat API, unrelated to sync)
  analytics.ts              anonymized chat_analytics logging
scripts/
  sync-content.ts             CLI entry point (`npm run sync` / `npm run sync:full`)
  sync-pdfs.ts                 CLI entry point (`npm run sync:pdfs`)
  seed-checkpoint-from-db.ts   one-time backfill if checkpoint and DB ever drift apart
sql/schema.sql               Postgres schema, match_content_chunks function
instrumentation.ts            starts the auto-sync scheduler once per server instance
public/embed.js               WordPress embed snippet
```

## Production notes

- **Rate limiting** is in-memory (`lib/rate-limit.ts`), capped at 15 messages/min per IP. This
  resets per serverless-function instance on Vercel, so it's a soft abuse guard rather than a
  hard global limit — swap in `@upstash/ratelimit` if you need a strict cross-instance cap.
- **Input limits**: messages over 2000 characters are rejected with a 400 before reaching OpenAI.
- **Graceful degradation**: if the Postgres vector search fails, `/api/chat` still answers (with
  no retrieved context, so the system prompt instructs the model to say it doesn't have the
  information) rather than hard-failing the request.
- **Error isolation**: `ChatErrorBoundary` means a widget crash renders nothing rather than
  breaking the host page.
- **Analytics**: every question is logged to `chat_analytics` (question text, whether any
  context was found, chunk count, a rough language hint) with no IP or identity captured, to
  spot content gaps over time.
- **Admin access**: `/admin` and every `/api/admin/*` route require the `admin_token` cookie to
  match `ADMIN_PASSWORD` exactly (`lib/admin/auth.ts`); with no `ADMIN_PASSWORD` set, admin access
  is unconditionally refused rather than left open.
