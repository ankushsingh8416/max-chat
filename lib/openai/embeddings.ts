import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { CHAT_EMBED_MAX_BACKOFF_MS, CHAT_EMBED_MAX_RETRIES, EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from "../constants";
import { withRetry, isRotatableKeyError } from "../sync/retry";
import { getActiveKey, keyCount, markKeyExhausted } from "./key-pool";

const providersByKey = new Map<string, ReturnType<typeof createOpenAI>>();

function getProviderForKey(apiKey: string) {
  let provider = providersByKey.get(apiKey);
  if (!provider) {
    provider = createOpenAI({ apiKey });
    providersByKey.set(apiKey, provider);
  }
  return provider;
}

/**
 * Single raw call to OpenAI's embeddings endpoint for a batch of texts. No
 * backoff here — that's the caller's job (see withRetry usage below) — but
 * it does rotate across the configured key pool (lib/openai/key-pool.ts) on
 * a quota/rate-limit/invalid-key error, trying every available key before
 * giving up. That happens here rather than in withRetry because switching
 * keys should be immediate, not paced with backoff like a same-key retry.
 *
 * Uses `text-embedding-3-small`, which defaults to 1536-dimensional output —
 * the `dimensions` provider option truncates it to 768 to match the
 * vector(768) column (OpenAI's v3 embedding models support arbitrary
 * dimensionality reduction the same way Matryoshka-trained models do; the
 * pgvector cosine distance operator normalizes by vector magnitude
 * internally, so truncated-but-unnormalized output works correctly).
 */
export async function embedBatchRaw(texts: string[]): Promise<number[][]> {
  const attempts = Math.max(1, keyCount());
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const apiKey = getActiveKey();
    const provider = getProviderForKey(apiKey);

    try {
      const { embeddings } = await embedMany({
        model: provider.textEmbeddingModel(OPENAI_EMBEDDING_MODEL),
        values: texts,
        maxRetries: 0, // retry/rotation handled explicitly below, not by the SDK's own backoff
        providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
      });
      if (embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}`);
      }
      return embeddings;
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
 * through a long backoff. Key rotation (above) already runs before this
 * retry budget is even touched.
 */
export async function embedText(text: string): Promise<number[]> {
  const values = await withRetry(() => embedBatchRaw([text]), {
    maxRetries: CHAT_EMBED_MAX_RETRIES,
    maxBackoffMs: CHAT_EMBED_MAX_BACKOFF_MS,
  });
  return values[0];
}
