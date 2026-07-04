/**
 * Truncated exponential backoff with jitter, for retrying transient OpenAI
 * API failures (429/500/503). When OpenAI's response includes a
 * `Retry-After` header, that value is used verbatim instead of the
 * calculated backoff, since the API is telling us exactly how long the
 * underlying limit needs to clear. The calculated backoff is only a
 * fallback for errors that don't carry one (plain 500s, network blips).
 *
 * A billing/plan-level quota (`error.code === "insufficient_quota"`) is
 * never worth retrying at all — it won't clear within any backoff we'd wait
 * for. Those errors are treated as non-retryable so a caller fails in
 * milliseconds instead of minutes; see `isDailyQuotaExhaustedError` below,
 * which lib/sync/sync-runner.ts uses to stop a whole sync run early instead
 * of grinding through every remaining page's retry budget for nothing. A
 * plain `rate_limit_exceeded` (per-minute/per-day request or token limit) is
 * still retryable/rotatable, since it clears on its own or on a key switch.
 */

export interface RetryOptions {
  maxRetries: number;
  maxBackoffMs: number;
  /** Base delay for attempt 1 before doubling; ignored once a Retry-After header is present. */
  baseDelayMs?: number;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

interface ParsedApiError {
  status?: number;
  retryDelayMs?: number;
  isQuotaExhausted: boolean;
}

/**
 * The `ai` package's `streamText`/`generateText`/`embedMany` wrap repeated
 * failures in a `RetryError` (`.reason: 'maxRetriesExceeded'`, `.lastError`,
 * `.errors[]`) after exhausting their own internal same-key retries — that
 * wrapper has no `.statusCode` of its own, so status/quota checks below
 * would silently see nothing unless unwrapped down to the real underlying
 * API error first.
 */
function unwrapError(err: unknown): unknown {
  const lastError = (err as { lastError?: unknown } | null)?.lastError;
  if (lastError instanceof Error && lastError !== err) return unwrapError(lastError);
  return err;
}

/**
 * The `ai` package's `AI_APICallError` (used for both chat and embeddings
 * via `@ai-sdk/openai`) sets `.statusCode`, and the JSON error body lives in
 * `.responseBody` (a string) or already-parsed in `.data.error`. OpenAI's
 * body shape is flat: `{ error: { message, type, code } }` — no nested
 * details array the way Google's did.
 */
function getErrorBody(err: Error): { error?: { code?: string; type?: string } } | undefined {
  const responseBody = (err as { responseBody?: string }).responseBody;
  if (typeof responseBody === "string") {
    try {
      return JSON.parse(responseBody);
    } catch {
      // fall through
    }
  }

  const data = (err as { data?: { error?: unknown } }).data;
  if (data?.error) return { error: data.error as { code?: string; type?: string } };

  try {
    return JSON.parse(err.message);
  } catch {
    return undefined;
  }
}

function getRetryDelayMs(err: Error): number | undefined {
  const headers = (err as { responseHeaders?: Record<string, string> }).responseHeaders;
  const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

function parseApiError(rawErr: unknown): ParsedApiError {
  const err = unwrapError(rawErr);
  if (!(err instanceof Error)) return { isQuotaExhausted: false };

  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  const parsed = getErrorBody(err);
  const code = parsed?.error?.code;

  return {
    status,
    retryDelayMs: getRetryDelayMs(err),
    // OpenAI's "insufficient_quota" means the account/billing limit is hit —
    // distinct from "rate_limit_exceeded", which clears on its own shortly.
    isQuotaExhausted: code === "insufficient_quota",
  };
}

/** Used by lib/sync/sync-runner.ts to stop a whole run early once a billing/plan quota is hit. */
export function isDailyQuotaExhaustedError(err: unknown): boolean {
  return parseApiError(err).isQuotaExhausted;
}

/**
 * True for any error worth rotating to a different API key over (see
 * lib/openai/key-pool.ts) — quota/rate-limit responses (429) or an invalid/
 * revoked key (401/403, or a 400/401 with an "invalid api key" message).
 */
export function isRotatableKeyError(rawErr: unknown): boolean {
  const err = unwrapError(rawErr);
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (status === 429 || status === 401 || status === 403) return true;
  return /invalid api key|incorrect api key/i.test(err.message);
}

function isRetryableError(err: unknown, status: number | undefined, isQuotaExhausted: boolean): boolean {
  if (isQuotaExhausted) return false; // won't clear within any retry budget we'd wait for
  if (status === 429 || status === 500 || status === 503) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNRESET|fetch failed/i.test(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { maxRetries, maxBackoffMs, baseDelayMs = 2000, onRetry } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const { status, retryDelayMs, isQuotaExhausted } = parseApiError(err);
      if (!isRetryableError(err, status, isQuotaExhausted) || attempt === maxRetries) throw err;

      const jitterMs = Math.random() * 300;
      const calculatedBackoffMs = Math.min(baseDelayMs * 2 ** attempt, maxBackoffMs);
      const waitMs = (retryDelayMs ?? calculatedBackoffMs) + jitterMs;

      onRetry?.(attempt + 1, waitMs, err);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}
