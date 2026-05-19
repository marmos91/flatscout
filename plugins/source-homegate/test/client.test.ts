import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { fetchSearch } from '../src/client.js';
import { HomegateAntiBotError, HomegateHttpError } from '../src/errors.js';
import { buildSearchBody, SearchConfig } from '../src/search.js';
import type { Transport, TransportRequestOpts, TransportResponse } from '../src/transport.js';

const logger = pino({ level: 'silent' });

function makeTransport(opts: {
  responses: Array<TransportResponse | (() => TransportResponse)>;
}): Transport & { calls: TransportRequestOpts[] } {
  let i = 0;
  const calls: TransportRequestOpts[] = [];
  const t: Transport & { calls: TransportRequestOpts[] } = {
    kind: 'bridge-inproc',
    calls,
    async request(o) {
      calls.push(o);
      const item = opts.responses[i++];
      if (item === undefined) throw new Error(`no more stub responses (call #${i})`);
      return typeof item === 'function' ? item() : item;
    },
  };
  return t;
}

const body = buildSearchBody(SearchConfig.parse({}), 5, 0);

function ctxWith(transport: Transport, retries = 2, on: number[] = [429, 500, 502, 503, 504]) {
  return {
    paceMs: 0,
    backoff: { on, retries, base_ms: 1 },
    signal: new AbortController().signal,
    logger,
    transport,
  };
}

const okBody = JSON.stringify({ from: 0, size: 5, total: 0, results: [] });

describe('fetchSearch', () => {
  it('returns the happy-path response', async () => {
    const t = makeTransport({ responses: [{ status: 200, body: okBody }] });
    const res = await fetchSearch(body, ctxWith(t));
    expect(res.results).toEqual([]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.method).toBe('POST');
  });

  it('throws HomegateAntiBotError on 403 (no Node-side recovery)', async () => {
    const t = makeTransport({ responses: [{ status: 403, body: 'blocked' }] });
    await expect(fetchSearch(body, ctxWith(t))).rejects.toBeInstanceOf(HomegateAntiBotError);
    expect(t.calls).toHaveLength(1);
  });

  it('retries on 429 then succeeds', async () => {
    const t = makeTransport({
      responses: [
        { status: 429, body: 'rate limited' },
        { status: 200, body: okBody },
      ],
    });
    const res = await fetchSearch(body, ctxWith(t, 2, [429]));
    expect(res.results).toEqual([]);
    expect(t.calls).toHaveLength(2);
  });

  it('throws HomegateHttpError when 500 budget is exhausted', async () => {
    const t = makeTransport({
      responses: [
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
      ],
    });
    await expect(fetchSearch(body, ctxWith(t, 2, [500]))).rejects.toBeInstanceOf(HomegateHttpError);
  });

  it('aborts when the AbortSignal fires before the next attempt', async () => {
    const ac = new AbortController();
    const t = makeTransport({
      responses: [{ status: 429, body: 'rate limited' }],
    });
    const ctx = {
      paceMs: 0,
      backoff: { on: [429], retries: 5, base_ms: 50 },
      signal: ac.signal,
      logger,
      transport: t,
    };
    const p = fetchSearch(body, ctx);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
