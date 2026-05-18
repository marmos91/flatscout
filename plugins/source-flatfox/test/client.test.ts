import { describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { fetchPage } from '../src/client.js';
import { SearchConfig } from '../src/search.js';

function mockedPool() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return {
    pool: agent.get('https://flatfox.ch'),
    agent,
  };
}

describe('fetchPage', () => {
  it('returns a 200 page', async () => {
    const { pool, agent } = mockedPool();
    pool.intercept({ method: 'GET', path: /\/api\/v1\/public-listing/ }).reply(200, {
      results: [{ pk: 1, city: 'Zürich' }],
      next: null,
    });
    const res = await fetchPage(SearchConfig.parse({}), 10, 0, {
      pool,
      paceMs: 0,
      backoff: { on: [429], retries: 0, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.results[0]?.pk).toBe(1);
    await agent.close();
  });

  it('retries on 429 then succeeds', async () => {
    const { pool, agent } = mockedPool();
    pool
      .intercept({ method: 'GET', path: /public-listing/ })
      .reply(429, 'rate limited')
      .times(1);
    pool.intercept({ method: 'GET', path: /public-listing/ }).reply(200, { results: [], next: null });
    const res = await fetchPage(SearchConfig.parse({}), 10, 0, {
      pool,
      paceMs: 0,
      backoff: { on: [429], retries: 1, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.results).toEqual([]);
    await agent.close();
  });

  it('throws after retries exhausted', async () => {
    const { pool, agent } = mockedPool();
    pool
      .intercept({ method: 'GET', path: /public-listing/ })
      .reply(500, 'boom')
      .times(2);
    await expect(
      fetchPage(SearchConfig.parse({}), 10, 0, {
        pool,
        paceMs: 0,
        backoff: { on: [500], retries: 1, base_ms: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/HTTP 500/);
    await agent.close();
  });
});
