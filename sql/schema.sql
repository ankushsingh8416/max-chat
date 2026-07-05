-- Max Estates chatbot — Postgres schema
-- Run this once against your Postgres instance (AWS RDS, or any other
-- standard Postgres with the `vector` extension available), e.g.:
--   psql "$DATABASE_URL" -f sql/schema.sql

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- content_chunks: RAG knowledge base, one row per chunk of synced WP content
-- ---------------------------------------------------------------------------
create table if not exists content_chunks (
  id            bigint generated always as identity primary key,
  source_url    text not null,
  title         text not null,
  post_type     text not null,
  chunk_text    text not null,
  chunk_index   int not null default 0,
  structured_data jsonb,
  embedding     vector(768) not null,
  last_modified timestamptz,
  created_at    timestamptz not null default now(),
  -- SHA-256 of the page's extracted text, repeated on every chunk row for
  -- that source_url. Lets the sync pipeline skip re-embedding a page whose
  -- content is byte-for-byte unchanged even when it's re-checked (e.g.
  -- project pages, always re-checked regardless of WP's `modified` field —
  -- see lib/sync/sync-runner.ts) — saves embedding cost, and separately
  -- catches page-builder edits that don't bump `modified` at all.
  content_hash  text
);

-- Nullable, metadata-only add for anyone running this file against a
-- database created before content_hash existed.
alter table content_chunks add column if not exists content_hash text;

-- Fast "delete all chunks for this page before re-inserting" during sync.
create index if not exists content_chunks_source_url_idx on content_chunks (source_url);
create index if not exists content_chunks_post_type_idx on content_chunks (post_type);
-- Structured factual lookups (price/location/RERA) without vector search.
create index if not exists content_chunks_structured_data_idx on content_chunks using gin (structured_data);

-- Approximate nearest-neighbor index for cosine similarity search.
-- IVFFlat requires ANALYZE after bulk loads and picks `lists` relative to row
-- count (~ sqrt(rows) is a reasonable starting point for a few thousand chunks).
create index if not exists content_chunks_embedding_idx
  on content_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ---------------------------------------------------------------------------
-- sync_logs: audit trail for each content-sync run
-- ---------------------------------------------------------------------------
create table if not exists sync_logs (
  id            bigint generated always as identity primary key,
  run_at        timestamptz not null default now(),
  status        text not null check (status in ('success', 'partial', 'failed')),
  pages_synced  int not null default 0,
  chunks_created int not null default 0,
  errors        jsonb not null default '[]'::jsonb
);

-- ---------------------------------------------------------------------------
-- chat_analytics: anonymized usage logging for future improvement
-- ---------------------------------------------------------------------------
create table if not exists chat_analytics (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  question      text not null,
  answer_found  boolean not null,
  matched_chunk_count int not null default 0,
  language_hint text
);

-- ---------------------------------------------------------------------------
-- RAG retrieval function: cosine similarity search over content_chunks
-- ---------------------------------------------------------------------------
create or replace function match_content_chunks(
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id bigint,
  source_url text,
  title text,
  post_type text,
  chunk_text text,
  structured_data jsonb,
  last_modified timestamptz,
  similarity float
)
language sql stable
as $$
  select
    id,
    source_url,
    title,
    post_type,
    chunk_text,
    structured_data,
    last_modified,
    1 - (embedding <=> query_embedding) as similarity
  from content_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- No Row Level Security / anon-vs-service-role split here (that was a
-- Supabase-specific construct for exposing Postgres directly to browser
-- clients). This app never connects to Postgres from the browser — every
-- query goes through server-side Next.js code (API routes, the sync
-- pipeline) using a single application DB user via DATABASE_URL — so access
-- control lives at the application layer instead (e.g. the admin upload
-- routes require a password-gated cookie; see lib/admin/auth.ts).
