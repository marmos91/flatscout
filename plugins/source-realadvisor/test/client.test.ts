import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { fetchPage } from '../src/client.js';
import { SearchConfig } from '../src/search.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'responses');
const pageOne = readFileSync(join(FIXTURE_DIR, 'page-1.json'), 'utf8');

let agent: MockAgent;
let prev: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  prev = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(prev);
});

describe('fetchPage', () => {
  it('parses page-1 response into listings + total_count', async () => {
    agent
      .get('https://realadvisor.ch')
      .intercept({ method: 'GET', path: /\/api\/listings/ })
      .reply(200, pageOne, { headers: { 'content-type': 'application/json' } });

    const res = await fetchPage(SearchConfig.parse({}), 1, {
      paceMs: 0,
      backoff: { on: [429], retries: 0, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.listings.length).toBeGreaterThan(0);
    expect(typeof res.total_count).toBe('number');
  });

  it('retries on 429 then succeeds', async () => {
    const pool = agent.get('https://realadvisor.ch');
    pool
      .intercept({ method: 'GET', path: /\/api\/listings/ })
      .reply(429, 'rate limited')
      .times(1);
    pool.intercept({ method: 'GET', path: /\/api\/listings/ }).reply(200, pageOne, {
      headers: { 'content-type': 'application/json' },
    });
    const res = await fetchPage(SearchConfig.parse({}), 1, {
      paceMs: 0,
      backoff: { on: [429], retries: 1, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.listings.length).toBeGreaterThan(0);
  });
});
