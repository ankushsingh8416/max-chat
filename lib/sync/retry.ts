/**
 * Truncated exponential backoff with jitter, for retrying transient Gemini
 * API failures (429/500/503). When Google's error response includes a
 * `RetryInfo.retryDelay` (it does for quota errors — e.g. "Please retry in
 * 57s"), that value is used verbatim instead of the calculated backoff,
 * since the API is telling us exactly how long the underlying limit needs to
 * clear. The calculated backoff is only a fallback for errors that don't
 * carry one (plain 500s, network blips).
 *
 * One quota is never worth retrying at all: a *daily* request-count cap
 * (quotaId containing "PerDay") won't clear in the ~60s Google's retryDelay
 * suggests — that field is written for per-minute limits and is misleading
 * here. Those errors are treated as non-retryable so a caller fails in
 * milliseconds instead of minutes; see `isDailyQuotaExhaustedError` below,
 * which lib/sync/sync-runner.ts uses to stop a whole sync run early instead
 * of grinding through every remaining page's retry budget for nothing.
 */

export interface RetryOptions {
  maxRetries: number;
  maxBackoffMs: number;
  /** Base delay for attempt 1 before doubling; ignored once retryDelay is present. */
  baseDelayMs?: number;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

interface ParsedGoogleError {
  status?: number;
  retryDelayMs?: number;
  isDailyQuotaExhausted: boolean;
}

/**
 * The `ai` package's `streamText`/`generateText` wrap repeated failures in a
 * `RetryError` (`.reason: 'maxRetriesExceeded'`, `.lastError`, `.errors[]`)
 * after exhausting their own internal same-key retries — that wrapper has no
 * `.status`/`.statusCode` of its own, so status/quota checks below would
 * silently see nothing and treat it as non-retryable/non-rotatable unless
 * unwrapped down to the real underlying API error first.
 */
function unwrapError(err: unknown): unknown {
  const lastError = (err as { lastError?: unknown } | null)?.lastError;
  if (lastError instanceof Error && lastError !== err) return unwrapError(lastError);
  return err;
}

/**
 * Two different SDKs in this codebase wrap the same underlying Gemini error
 * body differently:
 * - `@google/genai`'s `ApiError` (used for embeddings) sets `.status` to the
 *   HTTP status code and `.message` to `JSON.stringify(fullErrorBody)`.
 * - The `ai` package's `AI_APICallError` (used for chat via `@ai-sdk/google`)
 *   sets `.statusCode`, and the JSON body lives in `.responseBody` (a string)
 *   or already-parsed in `.data.error` — `.message` there is just a plain
 *   human-readable sentence, not JSON.
 * This tries every shape so the same retry/rotation logic works for both.
 */
function getErrorBody(err: Error): { error?: { code?: number; details?: unknown[] } } | undefined {
  try {
    return JSON.parse(err.message);
  } catch {
    // not the @google/genai shape — fall through
  }

  const responseBody = (err as { responseBody?: string }).responseBody;
  if (typeof responseBody === "string") {
    try {
      return JSON.parse(responseBody);
    } catch {
      // fall through
    }
  }

  const data = (err as { data?: { error?: unknown } }).data;
  if (data?.error) return { error: data.error as { code?: number; details?: unknown[] } };

  return undefined;
}

function parseGoogleApiError(rawErr: unknown): ParsedGoogleError {
  const err = unwrapError(rawErr);
  if (!(err instanceof Error)) return { isDailyQuotaExhausted: false };
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;

  const parsed = getErrorBody(err);
  if (!parsed) return { status, isDailyQuotaExhausted: false };

  const details = parsed.error?.details;

  const retryInfo = Array.isArray(details)
    ? details.find(
        (d): d is { retryDelay?: string } =>
          typeof d === "object" && d !== null && String((d as { "@type"?: string })["@type"]).includes("RetryInfo")
      )
    : undefined;
  const retryDelayStr = retryInfo?.retryDelay;
  const retryDelayMs = retryDelayStr ? Math.round(Number.parseFloat(retryDelayStr) * 1000) : undefined;

  const quotaFailure = Array.isArray(details)
    ? details.find(
        (d): d is { violations?: Array<{ quotaId?: string }> } =>
          typeof d === "object" && d !== null && String((d as { "@type"?: string })["@type"]).includes("QuotaFailure")
      )
    : undefined;
  const isDailyQuotaExhausted =
    quotaFailure?.violations?.some((v) => typeof v.quotaId === "string" && v.quotaId.includes("PerDay")) ?? false;

  return {
    status: status ?? parsed.error?.code,
    retryDelayMs: Number.isFinite(retryDelayMs) ? retryDelayMs : undefined,
    isDailyQuotaExhausted,
  };
}

/** Used by lib/sync/sync-runner.ts to stop a whole run early once the daily cap is hit. */
export function isDailyQuotaExhaustedError(err: unknown): boolean {
  return parseGoogleApiError(err).isDailyQuotaExhausted;
}

/**
 * True for any error worth rotating to a different API key over (see
 * lib/gemini/key-pool.ts) — quota/rate-limit responses (429) or an invalid/
 * revoked key (401/403, or a 400 with Google's "API key not valid" message).
 * Broader than `isDailyQuotaExhaustedError`: a per-minute 429 is also worth
 * an immediate key switch, not just a daily cap.
 */
export function isRotatableKeyError(rawErr: unknown): boolean {
  const err = unwrapError(rawErr);
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (status === 429 || status === 401 || status === 403) return true;
  return /api key not valid|invalid api key/i.test(err.message);
}

function isRetryableError(err: unknown, status: number | undefined, isDailyQuotaExhausted: boolean): boolean {
  if (isDailyQuotaExhausted) return false; // won't clear within any retry budget we'd wait for
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
      const { status, retryDelayMs, isDailyQuotaExhausted } = parseGoogleApiError(err);
      if (!isRetryableError(err, status, isDailyQuotaExhausted) || attempt === maxRetries) throw err;

      const jitterMs = Math.random() * 300;
      const calculatedBackoffMs = Math.min(baseDelayMs * 2 ** attempt, maxBackoffMs);
      const waitMs = (retryDelayMs ?? calculatedBackoffMs) + jitterMs;

      onRetry?.(attempt + 1, waitMs, err);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}
