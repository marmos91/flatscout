import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { crawlSeed } from '../src/discovery/external-seeds.js';

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

const NEWS_PAGE = `<html><body>
  <article>
    <h1>Erstbezug-Wochen-Übersicht</h1>
    <p>Folgende neue Projekte:</p>
    <ul>
      <li><a href="https://wohnpark-buchholzstrasse.ch/">Wohnpark Buchholzstrasse</a></li>
      <li><a href="https://halohomes.ch/">Halo Homes</a></li>
      <li><a href="https://www.homegate.ch/listing/123">Listing auf Homegate</a></li>
      <li><a href="/intern/about">Über uns</a></li>
      <li><a href="https://news.example/article/2">Andere News-Seite</a></li>
    </ul>
  </article>
</body></html>`;

describe('crawlSeed (plan b)', () => {
  it('extracts external candidates and filters portals/CDN', async () => {
    agent.get('https://news.example').intercept({ method: 'GET', path: '/article/1' }).reply(200, NEWS_PAGE);
    const cs = await crawlSeed('https://news.example/article/1', new AbortController().signal);
    const ids = cs.map((c) => c.id);
    expect(ids).toContain('wohnpark-buchholzstrasse');
    expect(ids).toContain('halohomes');
    // Self-host filtered.
    expect(ids).not.toContain('news');
    // Portal filtered.
    expect(ids).not.toContain('homegate');
    expect(cs.every((c) => c.source === 'pdp-url-mined')).toBe(true);
  });

  it('returns empty when the seed page itself errors', async () => {
    agent.get('https://news.example').intercept({ method: 'GET', path: '/dead' }).reply(500, '');
    const cs = await crawlSeed('https://news.example/dead', new AbortController().signal);
    expect(cs).toEqual([]);
  });

  it('dedupes by id across multiple anchor matches', async () => {
    const html = `<a href="https://walde.ch/x">x</a><a href="https://walde.ch/y">y</a><a href="https://walde.ch/z">z</a>`;
    agent.get('https://x.example').intercept({ method: 'GET', path: '/p' }).reply(200, html);
    const cs = await crawlSeed('https://x.example/p', new AbortController().signal);
    expect(cs.filter((c) => c.id === 'walde')).toHaveLength(1);
  });
});
