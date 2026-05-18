import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import pino from 'pino';
import type { BootstrapResult } from '@wabe/browser-runtime';
import { fetchSearch } from '../src/client.js';
import { HomegateAntiBotError, HomegateHttpError } from '../src/errors.js';
import { buildSearchBody, SearchConfig } from '../src/search.js';

const logger = pino({ level: 'silent' });

function makeCookies(tag: string): BootstrapResult {
  return {
    cookieHeader: `datadome=${tag}`,
    cookies: [{ name: 'datadome', value: tag, domain: '.homegate.ch', expires: null }],
    capturedAt: Date.now(),
    userAgent: 'test-ua',
  };
}

let originalDispatcher: Dispatcher;
let agent: MockAgent;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
});

function makeCtx(opts: {
  ensureBootstrap: ReturnType<typeof vi.fn>;
  retries?: number;
  on?: number[];
}) {
  return {
    dataDir: '/tmp/wabe-test',
    paceMs: 0,
    backoff: { on: opts.on ?? [429, 500, 502, 503, 504], retries: opts.retries ?? 2, base_ms: 1 },
    signal: new AbortController().signal,
    logger,
    ensureBootstrap: opts.ensureBootstrap as unknown as Parameters<typeof fetchSearch>[1]['ensureBootstrap'],
  };
}

const body = buildSearchBody(SearchConfig.parse({}), 5, 0);

describe('fetchSearch', () => {
  it('returns the happy-path response', async () => {
    const ensureBootstrap = vi.fn().mockResolvedValue(makeCookies('happy'));
    const pool = agent.get('https://api.homegate.ch');
    pool
      .intercept({ method: 'POST', path: '/search/listings' })
      .reply(200, { from: 0, size: 5, total: 0, results: [] });

    const res = await fetchSearch(body, makeCtx({ ensureBootstrap }));
    expect(res.results).toEqual([]);
    expect(ensureBootstrap).toHaveBeenCalledTimes(1);
  });

  it('on 403 invalidates cookies, re-bootstraps with force, retries', async () => {
    const ensureBootstrap = vi
      .fn()
      .mockResolvedValueOnce(makeCookies('stale'))
      .mockResolvedValueOnce(makeCookies('fresh'));

    const seenCookies: string[] = [];
    const pool = agent.get('https://api.homegate.ch');
    pool
      .intercept({ method: 'POST', path: '/search/listings' })
      .reply((opts) => {
        const cookie = (opts.headers as Record<string, string>).Cookie ?? '';
        seenCookies.push(cookie);
        if (seenCookies.length === 1) {
          return { statusCode: 403, data: 'forbidden' };
        }
        return { statusCode: 200, data: { from: 0, size: 5, total: 0, results: [] } };
      })
      .times(2);

    const res = await fetchSearch(body, makeCtx({ ensureBootstrap }));
    expect(res.results).toEqual([]);
    expect(ensureBootstrap).toHaveBeenCalledTimes(2);
    // Second call must be forced.
    expect(ensureBootstrap.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ force: true }));
    expect(seenCookies[0]).toContain('stale');
    expect(seenCookies[1]).toContain('fresh');
  });

  it('throws HomegateAntiBotError on a second 403', async () => {
    const ensureBootstrap = vi
      .fn()
      .mockResolvedValueOnce(makeCookies('first'))
      .mockResolvedValueOnce(makeCookies('second'));

    const pool = agent.get('https://api.homegate.ch');
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(403, 'blocked').times(2);

    await expect(fetchSearch(body, makeCtx({ ensureBootstrap }))).rejects.toBeInstanceOf(
      HomegateAntiBotError,
    );
  });

  it('retries on 429 then succeeds', async () => {
    const ensureBootstrap = vi.fn().mockResolvedValue(makeCookies('x'));
    const pool = agent.get('https://api.homegate.ch');
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(429, 'rate limited').times(1);
    pool
      .intercept({ method: 'POST', path: '/search/listings' })
      .reply(200, { from: 0, size: 5, total: 0, results: [] });
    const res = await fetchSearch(body, makeCtx({ ensureBootstrap, retries: 2, on: [429] }));
    expect(res.results).toEqual([]);
  });

  it('throws HomegateHttpError when 500 budget is exhausted', async () => {
    const ensureBootstrap = vi.fn().mockResolvedValue(makeCookies('x'));
    const pool = agent.get('https://api.homegate.ch');
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(500, 'boom').times(3);
    await expect(
      fetchSearch(body, makeCtx({ ensureBootstrap, retries: 2, on: [500] })),
    ).rejects.toBeInstanceOf(HomegateHttpError);
  });
});
