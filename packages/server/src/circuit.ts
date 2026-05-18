export interface CircuitOptions {
  failuresBeforeOpen: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(private opts: CircuitOptions) {}

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

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.opts.failuresBeforeOpen) {
      this.openedAt = (this.opts.now ?? Date.now)();
    }
  }

  state(): 'closed' | 'open' {
    return this.openedAt === null ? 'closed' : 'open';
  }
}
