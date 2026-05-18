export interface CircuitOptions {
  failuresBeforeOpen: number;
  cooldownMs: number;
  now?: () => number;
}

/**
 * Per-source circuit breaker that opens after `failuresBeforeOpen` consecutive
 * failures and stays open for `cooldownMs` before automatically re-closing.
 *
 * Lifecycle: `closed` → repeated `recordFailure()` reaches the threshold → `open`
 * (further `allow()` calls return false). After `cooldownMs` elapses, the next
 * `allow()` resets state to `closed` and lets the caller try again. A successful
 * `recordSuccess()` also resets state immediately. `now` is injectable for tests.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(private opts: CircuitOptions) {}

  /** Returns true if the caller may proceed; transitions back to `closed` if the cooldown has elapsed. */
  allow(): boolean {
    if (this.openedAt === null) return true;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.openedAt >= this.opts.cooldownMs) {
      this.openedAt = null;
      this.failures = 0;
      return true;
    }
    return false;
  }

  /** Resets the failure counter and forces the breaker closed. */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  /** Increments the failure counter and opens the breaker once the threshold is reached. */
  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.opts.failuresBeforeOpen) {
      this.openedAt = (this.opts.now ?? Date.now)();
    }
  }

  /** Snapshot of the current breaker state — does NOT advance the cooldown timer. */
  state(): 'closed' | 'open' {
    return this.openedAt === null ? 'closed' : 'open';
  }
}
