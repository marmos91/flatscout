import { describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { fetchPage } from '../src/client.js';
import type { AuthCfg } from '../src/auth.js';
import { SearchConfig } from '../src/search.js';

const auth: AuthCfg = {
  basic_user: 'hg_android',
  basic_pass: 'p',
  app_secret: 's',
  app_version: 'v',
  user_agent: 'ua',
};

function mocked() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return { agent, pool: agent.get('https://api.homegate.ch') };
}

const search = SearchConfig.parse({ location: { lat: 47.37, lon: 8.54 } });

describe('fetchPage', () => {
  it('parses a 200 page', async () => {
    const { agent, pool } = mocked();
    pool
      .intercept({ method: 'POST', path: '/search/listings' })
      .reply(200, { results: [{ listing: { id: 'x' } }], total: 1 });
    const r = await fetchPage(search, 10, 0, {
      pool,
      auth,
      paceMs: 0,
      backoff: { on: [429, 500], retries: 0, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(r.results).toHaveLength(1);
    await agent.close();
  });

  it('throws HomegateAuthError on 401', async () => {
    const { agent, pool } = mocked();
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(401, 'denied');
    await expect(
      fetchPage(search, 10, 0, {
        pool,
        auth,
        paceMs: 0,
        backoff: { on: [], retries: 0, base_ms: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/auth 401/);
    await agent.close();
  });

  it('retries on 500 then succeeds', async () => {
    const { agent, pool } = mocked();
    pool.intercept({ method: 'POST', path: '/search/listings' }).reply(500, 'boom').times(1);
    pool
      .intercept({ method: 'POST', path: '/search/listings' })
      .reply(200, { results: [], total: 0 });
    const r = await fetchPage(search, 10, 0, {
      pool,
      auth,
      paceMs: 0,
      backoff: { on: [500], retries: 1, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(r.total).toBe(0);
    await agent.close();
  });
});
