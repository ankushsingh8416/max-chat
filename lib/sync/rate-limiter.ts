import { sleep } from "./retry";

/**
 * Enforces a minimum spacing between successive calls that pass through it.
 * Global/shared across whatever concurrency the queue allows, so raising
 * EMBEDDING_CONCURRENCY later still respects one overall pace rather than
 * each worker pacing independently.
 */
export class RateLimiter {
  private lastStartedAt = 0;

  constructor(private readonly minDelayMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastStartedAt;
    const remaining = this.minDelayMs - elapsed;
    if (remaining > 0) await sleep(remaining);
    this.lastStartedAt = Date.now();
  }
}
