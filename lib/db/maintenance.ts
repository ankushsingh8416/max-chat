import { getPool } from "./pool";

/**
 * Rebuilds the IVFFlat approximate-nearest-neighbor index on content_chunks
 * and refreshes planner statistics. IVFFlat clusters vectors into `lists`
 * buckets at index-build time based on whatever data existed then — if every
 * embedding is later replaced with vectors from a different embedding space
 * (e.g. switching providers/models, as happened migrating Gemini -> OpenAI),
 * the old clustering no longer matches the new data's geometry, and
 * `ORDER BY embedding <=> query LIMIT n` can silently return few or zero
 * results for large parts of the query space — confirmed directly: a plain
 * SELECT evaluating the same distance expression returned correct values for
 * every row, but the ORDER BY + LIMIT query (which is what actually uses the
 * index) returned nothing, until this reindex.
 *
 * Called automatically after a --reset-checkpoint sync (lib/sync/sync-runner.ts,
 * lib/sync/pdf-sync.ts), since that's precisely the "everything just got
 * re-embedded" signal. Also runnable directly via `npm run db:reindex`.
 */
export async function reindexEmbeddingIndex(): Promise<void> {
  const pool = getPool();
  await pool.query("REINDEX INDEX content_chunks_embedding_idx");
  await pool.query("ANALYZE content_chunks");
}
