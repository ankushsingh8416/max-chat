import { CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS } from "./constants";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Simple in-memory fixed-window rate limiter, keyed by caller-supplied key
 * (typically `${route}:${ip}` so different endpoints don't share a budget).
 *
 * Caveat: on Vercel this state lives per serverless-function instance, so a
 * client bouncing across instances can exceed the nominal limit. That's an
 * acceptable tradeoff for a soft abuse guard; swap this module for an
 * Upstash Redis-backed limiter (`@upstash/ratelimit`) if you need a hard
 * global limit across all instances.
 */
const buckets = new Map<string, Bucket>();

// Periodically evict stale buckets so this map doesn't grow unbounded over a
// long-lived serverless instance's lifetime.
const MAX_TRACKED_KEYS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

const DEFAULT_OPTIONS: RateLimitOptions = { max: CHAT_RATE_LIMIT_MAX, windowMs: CHAT_RATE_LIMIT_WINDOW_MS };

export function checkRateLimit(key: string, options: RateLimitOptions = DEFAULT_OPTIONS): RateLimitResult {
  const { max, windowMs } = options;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }

  if (existing.count >= max) {
    return { allowed: false, remaining: 0, resetAt: existing.windowStart + windowMs };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: max - existing.count,
    resetAt: existing.windowStart + windowMs,
  };
}

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return headers.get("x-real-ip") || "unknown";
}
