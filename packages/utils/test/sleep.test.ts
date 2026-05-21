import { describe, expect, it } from 'vitest';
import { sleep } from '../src/sleep.js';

describe('sleep', () => {
  it('resolves after the timeout', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    await sleep(20, ac.signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(18);
  });

  it('rejects when signal aborts before the timeout', async () => {
    const ac = new AbortController();
    const p = sleep(1000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow('aborted');
  });
});
