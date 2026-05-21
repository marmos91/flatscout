import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { fetchSrp } from '../src/client.js';
import { IS24AntiBotError, IS24HttpError } from '../src/errors.js';
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

const ctxBase = {
  paceMs: 0,
  backoff: { on: [429, 500, 502, 503, 504], retries: 2, base_ms: 1 },
  signal: new AbortController().signal,
  logger,
};

const okBody = '<html><body>ok</body></html>';

describe('fetchSrp', () => {
  it('returns the happy-path response body + status', async () => {
    const t = makeTransport({ responses: [{ status: 200, body: okBody }] });
    const res = await fetchSrp('https://x', { ...ctxBase, transport: t });
    expect(res.body).toBe(okBody);
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.method).toBe('GET');
  });

  it('throws IS24AntiBotError on 403', async () => {
    const t = makeTransport({ responses: [{ status: 403, body: 'blocked' }] });
    await expect(fetchSrp('https://x', { ...ctxBase, transport: t })).rejects.toBeInstanceOf(
      IS24AntiBotError,
    );
  });

  it('retries on 429 then succeeds', async () => {
    const t = makeTransport({
      responses: [
        { status: 429, body: 'slow down' },
        { status: 200, body: okBody },
      ],
    });
    const res = await fetchSrp('https://x', {
      ...ctxBase,
      transport: t,
      backoff: { on: [429], retries: 2, base_ms: 1 },
    });
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });

  it('throws IS24HttpError when 500 budget is exhausted', async () => {
    const t = makeTransport({
      responses: [
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
      ],
    });
    await expect(
      fetchSrp('https://x', {
        ...ctxBase,
        transport: t,
        backoff: { on: [500], retries: 2, base_ms: 1 },
      }),
    ).rejects.toBeInstanceOf(IS24HttpError);
  });

  it('aborts before the next attempt when the signal fires', async () => {
    const ac = new AbortController();
    const t = makeTransport({
      responses: [
        () => {
          ac.abort();
          return { status: 500, body: 'x' };
        },
      ],
    });
    await expect(
      fetchSrp('https://x', {
        ...ctxBase,
        transport: t,
        signal: ac.signal,
        backoff: { on: [500], retries: 2, base_ms: 1000 },
      }),
    ).rejects.toThrow(/aborted/);
  });
});
