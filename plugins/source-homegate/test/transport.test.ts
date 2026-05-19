import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import type { BootstrapResult } from '@wabe/browser-runtime';
import {
  HomegateBridgeTransport,
  PlaywrightTransport,
  UndiciTransport,
  selectTransport,
} from '../src/transport.js';

const logger = pino({ level: 'silent' });

function makeCookies(tag: string): BootstrapResult {
  return {
    cookieHeader: `datadome=${tag}`,
    cookies: [{ name: 'datadome', value: tag, domain: '.homegate.ch', expires: null }],
    capturedAt: Date.now(),
    userAgent: 'test-ua',
  };
}

let dispatcher: Dispatcher;
let agent: MockAgent;
let dir: string;

beforeEach(() => {
  dispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  dir = mkdtempSync(join(tmpdir(), 'wabe-hg-transport-'));
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(dispatcher);
  rmSync(dir, { recursive: true, force: true });
});

describe('UndiciTransport', () => {
  it('issues a request with default JSON headers', async () => {
    const pool = agent.get('https://api.homegate.ch');
    let seenHeaders: Record<string, string> = {};
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply((req) => {
      seenHeaders = (req.headers as Record<string, string>) ?? {};
      return { statusCode: 200, data: '{}' };
    });
    const t = new UndiciTransport();
    const res = await t.request({
      method: 'POST',
      url: 'https://api.homegate.ch/search/listings',
      hasBody: true,
      body: '{}',
      signal: new AbortController().signal,
      logger,
    });
    expect(res.status).toBe(200);
    expect(seenHeaders['content-type']).toBe('application/json');
  });

  it('invalidateAndRetryOnce returns false', async () => {
    expect(await new UndiciTransport().invalidateAndRetryOnce('x', logger)).toBe(false);
  });
});

describe('PlaywrightTransport', () => {
  it('bootstraps cookies+UA on first call and attaches them as headers', async () => {
    const ensureBootstrapFn = vi.fn().mockResolvedValue(makeCookies('boot'));
    const pool = agent.get('https://api.homegate.ch');
    let cookie = '';
    let ua = '';
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply((req) => {
      const h = (req.headers as Record<string, string>) ?? {};
      cookie = h.Cookie ?? h.cookie ?? '';
      ua = h['User-Agent'] ?? h['user-agent'] ?? '';
      return { statusCode: 200, data: '{}' };
    });
    const t = new PlaywrightTransport({ dataDir: dir, ensureBootstrapFn });
    const res = await t.request({
      method: 'POST',
      url: 'https://api.homegate.ch/search/listings',
      hasBody: true,
      body: '{}',
      signal: new AbortController().signal,
      logger,
    });
    expect(res.status).toBe(200);
    expect(ensureBootstrapFn).toHaveBeenCalledTimes(1);
    expect(cookie).toContain('boot');
    expect(ua).toBe('test-ua');
  });

  it('reuses bootstrap across multiple requests', async () => {
    const ensureBootstrapFn = vi.fn().mockResolvedValue(makeCookies('once'));
    const pool = agent.get('https://api.homegate.ch');
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(200, '{}').times(2);
    const t = new PlaywrightTransport({ dataDir: dir, ensureBootstrapFn });
    const sig = new AbortController().signal;
    await t.request({
      method: 'POST',
      url: 'https://api.homegate.ch/search/listings',
      hasBody: true,
      body: '{}',
      signal: sig,
      logger,
    });
    await t.request({
      method: 'POST',
      url: 'https://api.homegate.ch/search/listings',
      hasBody: true,
      body: '{}',
      signal: sig,
      logger,
    });
    expect(ensureBootstrapFn).toHaveBeenCalledTimes(1);
  });

  it('invalidateAndRetryOnce re-bootstraps with force=true', async () => {
    const ensureBootstrapFn = vi
      .fn()
      .mockResolvedValueOnce(makeCookies('first'))
      .mockResolvedValueOnce(makeCookies('forced'));
    const t = new PlaywrightTransport({ dataDir: dir, ensureBootstrapFn });
    // Prime via a request so initial bootstrap runs.
    const pool = agent.get('https://api.homegate.ch');
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(200, '{}');
    await t.request({
      method: 'POST',
      url: 'https://api.homegate.ch/search/listings',
      hasBody: true,
      body: '{}',
      signal: new AbortController().signal,
      logger,
    });
    const retried = await t.invalidateAndRetryOnce('test', logger);
    expect(retried).toBe(true);
    expect(ensureBootstrapFn).toHaveBeenCalledTimes(2);
    expect(ensureBootstrapFn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ force: true }));
  });
});

describe('HomegateBridgeTransport', () => {
  it('invalidateAndRetryOnce returns false (no Wabe-side credential state)', async () => {
    expect(await new HomegateBridgeTransport().invalidateAndRetryOnce()).toBe(false);
  });
});

describe('selectTransport', () => {
  it('returns PlaywrightTransport when no bridge is connected or paired', () => {
    const t = selectTransport({ dataDir: dir, logger, checkHeartbeat: false });
    expect(t.kind).toBe('playwright');
  });
});
