import { embedBatchRaw } from "../gemini/embeddings";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_CONCURRENCY,
  EMBEDDING_DELAY_MS,
  MAX_BACKOFF_MS,
  MAX_EMBED_RETRIES,
} from "../constants";
import { RateLimiter } from "./rate-limiter";
import { ConcurrencyQueue } from "./queue";
import { withRetry } from "./retry";
import { logRetry } from "./logger";

const rateLimiter = new RateLimiter(EMBEDDING_DELAY_MS);
const queue = new ConcurrencyQueue(EMBEDDING_CONCURRENCY);

let retryCount = 0;
export function resetRetryCount(): void {
  retryCount = 0;
}
export function getRetryCount(): number {
  return retryCount;
}

/**
 * Embeds many chunks for the bulk sync pipeline: batched into
 * EMBEDDING_BATCH_SIZE-sized requests (fewer, larger requests use less of
 * Gemini's daily request-count quota than many small ones), each call paced
 * by a shared RateLimiter and bounded by a ConcurrencyQueue (both
 * configurable via env — see lib/constants.ts), with truncated exponential
 * backoff that honors Google's own `retryDelay` when a 429 includes one.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchResult = await queue.run(() =>
      withRetry(
        async () => {
          await rateLimiter.wait();
          return embedBatchRaw(batch);
        },
        {
          maxRetries: MAX_EMBED_RETRIES,
          maxBackoffMs: MAX_BACKOFF_MS,
          onRetry: (attempt, waitMs, err) => {
            retryCount += 1;
            logRetry(attempt, waitMs, err);
          },
        }
      )
    );
    results.push(...batchResult);
  }

  return results;
}
