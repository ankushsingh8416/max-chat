import { GoogleGenAI } from "@google/genai";
import { CHAT_EMBED_MAX_BACKOFF_MS, CHAT_EMBED_MAX_RETRIES, EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_MODEL } from "../constants";
import { withRetry, isRotatableKeyError } from "../sync/retry";
import { getActiveKey, keyCount, markKeyExhausted } from "./key-pool";

const clientsByKey = new Map<string, GoogleGenAI>();

function getClientForKey(apiKey: string): GoogleGenAI {
  let client = clientsByKey.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clientsByKey.set(apiKey, client);
  }
  return client;
}

/**
 * Single raw call to Gemini's embedContent for a batch of texts. No backoff
 * here — that's the caller's job (see withRetry usage below) — but it does
 * rotate across the configured key pool (lib/gemini/key-pool.ts) on a
 * quota/rate-limit/invalid-key error, trying every available key before
 * giving up. That happens here rather than in withRetry because switching
 * keys should be immediate, not paced with backoff like a same-key retry.
 *
 * Uses `gemini-embedding-001`, which defaults to 3072-dimensional output —
 * `outputDimensionality` truncates it to match the 768-dim column in
 * `content_chunks` (Matryoshka representation truncation; the model was
 * trained so leading dimensions carry the most signal, and pgvector's cosine
 * distance operator normalizes by vector magnitude internally, so the
 * truncated-but-unnormalized output works correctly without extra rescaling).
 */
export async function embedBatchRaw(texts: string[]): Promise<number[][]> {
  const attempts = Math.max(1, keyCount());
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const apiKey = getActiveKey();
    const ai = getClientForKey(apiKey);

    try {
      const res = await ai.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: texts,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      if (!res.embeddings || res.embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${res.embeddings?.length ?? 0}`);
      }
      return res.embeddings.map((e) => {
        if (!e.values) throw new Error("Embedding response missing values");
        return e.values;
      });
    } catch (err) {
      lastErr = err;
      if (isRotatableKeyError(err) && keyCount() > 1) {
        markKeyExhausted(apiKey);
        continue; // immediately retry with the next key, no backoff needed
      }
      throw err;
    }
  }

  throw lastErr;
}

/**
 * Embeds a single query string at chat time. Uses a deliberately short retry
 * budget (CHAT_EMBED_MAX_RETRIES/CHAT_EMBED_MAX_BACKOFF_MS, not the bulk
 * sync's) — a live request needs to fail in ~1-2s, not patiently wait
 * through a minutes-long Gemini quota backoff. Daily-quota errors specifically
 * are never retried at all (see lib/sync/retry.ts), so this mainly protects
 * against genuine transient 500s/503s taking too long. Key rotation (above)
 * already runs before this retry budget is even touched.
 */
export async function embedText(text: string): Promise<number[]> {
  const values = await withRetry(() => embedBatchRaw([text]), {
    maxRetries: CHAT_EMBED_MAX_RETRIES,
    maxBackoffMs: CHAT_EMBED_MAX_BACKOFF_MS,
  });
  return values[0];
}
