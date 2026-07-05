import { getPool } from "./pool";
import type { ContentChunkRow, MatchedChunk } from "./types";

const CHUNK_SELECT_COLUMNS = "id, source_url, title, post_type, chunk_text, structured_data, last_modified";

/** pgvector accepts a plain `[v1,v2,...]` text literal for both input and query parameters. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

interface RawChunkRow {
  id: number | string;
  source_url: string;
  title: string;
  post_type: string;
  chunk_text: string;
  structured_data: unknown;
  last_modified: string | Date | null;
  similarity?: number | string;
}

function mapRow(row: RawChunkRow): MatchedChunk {
  return {
    id: Number(row.id),
    source_url: row.source_url,
    title: row.title,
    post_type: row.post_type,
    chunk_text: row.chunk_text,
    structured_data: (row.structured_data as MatchedChunk["structured_data"]) ?? null,
    last_modified: row.last_modified ? new Date(row.last_modified).toISOString() : null,
    similarity: row.similarity !== undefined ? Number(row.similarity) : 1,
  };
}

export async function deleteChunksBySourceUrl(sourceUrl: string): Promise<void> {
  await getPool().query("delete from content_chunks where source_url = $1", [sourceUrl]);
}

/**
 * Bulk-inserts chunk rows in a single statement. Mirrors the Supabase
 * `.insert(rows)` call this replaced — one round trip regardless of how many
 * chunks a page produced.
 */
export async function insertContentChunks(rows: ContentChunkRow[]): Promise<void> {
  if (rows.length === 0) return;

  const columns = [
    "source_url",
    "title",
    "post_type",
    "chunk_text",
    "chunk_index",
    "structured_data",
    "embedding",
    "last_modified",
    "content_hash",
  ];
  const values: unknown[] = [];
  const rowPlaceholders = rows.map((row, i) => {
    const base = i * columns.length;
    values.push(
      row.source_url,
      row.title,
      row.post_type,
      row.chunk_text,
      row.chunk_index,
      row.structured_data ? JSON.stringify(row.structured_data) : null,
      toVectorLiteral(row.embedding),
      row.last_modified,
      row.content_hash ?? null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::vector, $${base + 8}, $${base + 9})`;
  });

  const sql = `insert into content_chunks (${columns.join(", ")}) values ${rowPlaceholders.join(", ")}`;
  await getPool().query(sql, values);
}

/** The stored content_hash for a page's chunks (all rows share the same value), or null if not synced/tracked yet. */
export async function getContentHash(sourceUrl: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `select content_hash from content_chunks where source_url = $1 and content_hash is not null limit 1`,
    [sourceUrl]
  );
  return rows[0]?.content_hash ?? null;
}

/** The currently-stored last_modified for a page, if it's been synced before — see extractPageDate's callers for why this matters. */
export async function getStoredLastModified(sourceUrl: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `select last_modified from content_chunks where source_url = $1 and last_modified is not null limit 1`,
    [sourceUrl]
  );
  return rows[0]?.last_modified ? new Date(rows[0].last_modified).toISOString() : null;
}

/** Cosine-similarity search via the match_content_chunks() SQL function (see sql/schema.sql). */
export async function matchContentChunks(
  queryEmbedding: number[],
  matchThreshold: number,
  matchCount: number
): Promise<MatchedChunk[]> {
  const { rows } = await getPool().query(`select * from match_content_chunks($1::vector, $2, $3)`, [
    toVectorLiteral(queryEmbedding),
    matchThreshold,
    matchCount,
  ]);
  return rows.map(mapRow);
}

/** Every chunk of every admin-uploaded document, unconditionally — see MAX_MANUAL_UPLOAD_CONTEXT_CHUNKS. */
export async function selectManualUploadChunksForContext(postType: string, limit: number): Promise<MatchedChunk[]> {
  const { rows } = await getPool().query(
    `select ${CHUNK_SELECT_COLUMNS} from content_chunks where post_type = $1 order by created_at desc limit $2`,
    [postType, limit]
  );
  return rows.map(mapRow);
}

/** Every project's own chunk_index=0 row — used for "list every project" completeness queries. */
export async function selectAllProjectsChunkZero(postTypes: string[]): Promise<MatchedChunk[]> {
  const { rows } = await getPool().query(
    `select ${CHUNK_SELECT_COLUMNS} from content_chunks where post_type = any($1) and chunk_index = 0 limit 50`,
    [postTypes]
  );
  return rows.map(mapRow);
}

/** Structured-data project rows filtered by title, used for direct price/location/RERA-style lookups. */
export async function selectStructuredProjectChunksByTitle(
  postTypes: string[],
  titleTerms: string[]
): Promise<MatchedChunk[]> {
  const params: unknown[] = [postTypes];
  let where = `post_type = any($1) and structured_data is not null`;

  if (titleTerms.length > 0) {
    const likeClauses = titleTerms.map((term) => {
      params.push(`%${term}%`);
      return `title ilike $${params.length}`;
    });
    where += ` and (${likeClauses.join(" or ")})`;
  }

  const { rows } = await getPool().query(
    `select ${CHUNK_SELECT_COLUMNS} from content_chunks where ${where} limit 8`,
    params
  );
  return rows.map(mapRow);
}

/** Most-recently-modified chunk_index=0 rows — used for "what's the latest blog" style recency queries. */
export async function selectRecentChunks(postTypes: string[], limit: number): Promise<MatchedChunk[]> {
  const { rows } = await getPool().query(
    `select ${CHUNK_SELECT_COLUMNS} from content_chunks where post_type = any($1) and chunk_index = 0 order by last_modified desc nulls last limit $2`,
    [postTypes, limit]
  );
  return rows.map(mapRow);
}

/**
 * chunk_index=0 rows within `windowDays` of a specific date, closest first —
 * used for "was anything published on 26 June" style date-specific queries,
 * distinct from selectRecentChunks' "give me the newest N" (see
 * lib/rag.ts's parseDateFromQuery for why these need different lookups).
 * Returning the closest matches even when nothing lands exactly on the
 * target date lets the model answer honestly ("nothing on the 26th, but
 * here's the 24th") instead of a blank "not found."
 */
export async function selectPostsNearDate(
  postTypes: string[],
  targetDate: string,
  windowDays: number,
  limit: number
): Promise<MatchedChunk[]> {
  const { rows } = await getPool().query(
    `select ${CHUNK_SELECT_COLUMNS} from content_chunks
     where post_type = any($1) and chunk_index = 0
       and last_modified between $2::timestamptz - ($3 || ' days')::interval
                            and $2::timestamptz + ($3 || ' days')::interval
     order by abs(extract(epoch from (last_modified - $2::timestamptz)))
     limit $4`,
    [postTypes, targetDate, windowDays, limit]
  );
  return rows.map(mapRow);
}

/** Every synced page's identity/freshness info, used to backfill the local sync checkpoint. */
export async function selectAllSourceInfo(): Promise<
  { source_url: string; post_type: string; last_modified: string | null }[]
> {
  const { rows } = await getPool().query(`select source_url, post_type, last_modified from content_chunks`);
  return rows.map((row: { source_url: string; post_type: string; last_modified: string | Date | null }) => ({
    source_url: row.source_url,
    post_type: row.post_type,
    last_modified: row.last_modified ? new Date(row.last_modified).toISOString() : null,
  }));
}

export interface ManualUploadSummary {
  sourceUrl: string;
  title: string;
  uploadedAt: string;
  chunkCount: number;
}

/** One row per uploaded document (grouped from its underlying chunks) for the admin "trained docs" list. */
export async function selectManualUploads(postType: string): Promise<ManualUploadSummary[]> {
  const { rows } = await getPool().query(
    `select source_url, title, created_at from content_chunks where post_type = $1 order by created_at desc`,
    [postType]
  );

  const bySource = new Map<string, ManualUploadSummary>();
  for (const row of rows as { source_url: string; title: string; created_at: string | Date }[]) {
    const existing = bySource.get(row.source_url);
    if (existing) {
      existing.chunkCount += 1;
    } else {
      bySource.set(row.source_url, {
        sourceUrl: row.source_url,
        title: row.title,
        uploadedAt: new Date(row.created_at).toISOString(),
        chunkCount: 1,
      });
    }
  }
  return Array.from(bySource.values());
}

export async function deleteManualUpload(sourceUrl: string, postType: string): Promise<void> {
  await getPool().query(`delete from content_chunks where source_url = $1 and post_type = $2`, [
    sourceUrl,
    postType,
  ]);
}

export interface ContentStats {
  totalPages: number;
  totalChunks: number;
  byPostType: { postType: string; pages: number; chunks: number }[];
}

/** Indexed-content overview for the admin dashboard. */
export async function getContentStats(): Promise<ContentStats> {
  const { rows } = await getPool().query(
    `select post_type, count(distinct source_url) as pages, count(*) as chunks
     from content_chunks group by post_type order by chunks desc`
  );
  const byPostType = rows.map((r: { post_type: string; pages: string; chunks: string }) => ({
    postType: r.post_type,
    pages: Number(r.pages),
    chunks: Number(r.chunks),
  }));
  return {
    totalPages: byPostType.reduce((sum, r) => sum + r.pages, 0),
    totalChunks: byPostType.reduce((sum, r) => sum + r.chunks, 0),
    byPostType,
  };
}

export interface IndexedPageSummary {
  sourceUrl: string;
  title: string;
  postType: string;
  chunkCount: number;
  lastModified: string | null;
}

/** Simple ILIKE search over title/chunk text, for the admin "search indexed content" tool. */
export async function searchIndexedContent(query: string, limit: number): Promise<IndexedPageSummary[]> {
  const { rows } = await getPool().query(
    `select source_url, title, post_type, count(*) as chunk_count, max(last_modified) as last_modified
     from content_chunks
     where title ilike $1 or chunk_text ilike $1
     group by source_url, title, post_type
     order by max(created_at) desc
     limit $2`,
    [`%${query}%`, limit]
  );
  return rows.map((r: { source_url: string; title: string; post_type: string; chunk_count: string; last_modified: string | Date | null }) => ({
    sourceUrl: r.source_url,
    title: r.title,
    postType: r.post_type,
    chunkCount: Number(r.chunk_count),
    lastModified: r.last_modified ? new Date(r.last_modified).toISOString() : null,
  }));
}
