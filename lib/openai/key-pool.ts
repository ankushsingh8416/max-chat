/**
 * Rotates across multiple OpenAI API keys so a quota/rate-limit or invalid-
 * key error on one key doesn't stall the whole app — the next call (or, for
 * bulk embedding, the very same call) automatically moves to the next key.
 *
 * Configure via `OPENAI_API_KEYS` (comma-separated). `OPENAI_API_KEY` alone
 * still works as a single-key fallback and is folded into the pool if set.
 */

interface KeyEntry {
  key: string;
  exhaustedUntil: number | null;
}

const EXHAUSTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let pool: KeyEntry[] | null = null;
let cursor = 0;

function parseKeys(): string[] {
  const keys = (process.env.OPENAI_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const single = process.env.OPENAI_API_KEY?.trim();
  if (single && !keys.includes(single)) keys.unshift(single);

  return keys;
}

function getPool(): KeyEntry[] {
  if (!pool) {
    const keys = parseKeys();
    if (keys.length === 0) {
      throw new Error("No OpenAI API key configured — set OPENAI_API_KEY or OPENAI_API_KEYS");
    }
    pool = keys.map((key) => ({ key, exhaustedUntil: null }));
  }
  return pool;
}

/** Returns a currently-healthy key, cycling forward from the last-used position. */
export function getActiveKey(): string {
  const entries = getPool();
  const now = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const idx = (cursor + i) % entries.length;
    if (!entries[idx].exhaustedUntil || entries[idx].exhaustedUntil <= now) {
      cursor = idx;
      return entries[idx].key;
    }
  }

  // Every key is currently marked exhausted — fall back to whichever recovers
  // soonest rather than throwing here; the caller's own error handling
  // (see lib/sync/retry.ts's isDailyQuotaExhaustedError) still applies.
  const soonest = entries.reduce((a, b) => ((a.exhaustedUntil ?? 0) < (b.exhaustedUntil ?? 0) ? a : b));
  return soonest.key;
}

/** Marks a key as exhausted for ~24h and advances the pool past it. */
export function markKeyExhausted(key: string): void {
  const entries = getPool();
  const idx = entries.findIndex((e) => e.key === key);
  if (idx === -1) return;

  entries[idx].exhaustedUntil = Date.now() + EXHAUSTION_COOLDOWN_MS;
  cursor = (idx + 1) % entries.length;
  console.warn(`[openai] Key ending ...${key.slice(-6)} marked exhausted — rotating to the next key.`);
}

export function keyCount(): number {
  return getPool().length;
}
