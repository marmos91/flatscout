import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/circuit.js';

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 1000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
    cb.recordFailure();
    expect(cb.allow()).toBe(false);
  });
  it('closes after cooldown', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failuresBeforeOpen: 2, cooldownMs: 1000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(false);
    now = 1500;
    expect(cb.allow()).toBe(true);
  });
  it('success resets failure count', () => {
    let now = 0;
    const cb = new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 1000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
  });
});
