import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { fingerprint } from '../src/index.js';

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

const REL = `<html><head><script type="application/ld+json">{"@type":"RealEstateListing","name":"x"}</script></head></html>`;
const ORG = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"agency"}</script></head></html>`;
const SITEMAP_URLSET = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agency.example/about</loc></url>
  <url><loc>https://agency.example/objekt/12345-zurich-3-zimmer</loc></url>
</urlset>`;
const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://agency.example/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://agency.example/sitemap-objekte.xml</loc></sitemap>
</sitemapindex>`;
const SITEMAP_OBJEKTE = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agency.example/objekt/789-wohnung</loc></url>
</urlset>`;

describe('fingerprint', () => {
  it('classifies homepage match directly without fetching sitemap', async () => {
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/' })
      .reply(200, `<html><head><meta name="generator" content="ImmoMig 5.4"></head></html>`);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('immomig');
    expect(r.matched_url).toBe('https://agency.example/');
    expect(r.sitemap_url).toBeUndefined();
  });

  it('follows redirects before classifying', async () => {
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/' })
      .reply(301, '', { headers: { location: 'https://agency.example/de' } });
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/de' })
      .reply(200, `<html><body><script src="https://casasoft.ch/widget.js"></script></body></html>`);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('casasoft');
  });

  it('falls back to sitemap-sampled detail page when homepage is inconclusive', async () => {
    // Homepage has only Organization JSON-LD — doesn't trigger schemaorg heuristic.
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    // robots.txt not found.
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    // /sitemap.xml exists.
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap.xml' })
      .reply(200, SITEMAP_URLSET, { headers: { 'content-type': 'text/xml' } });
    // Detail page has RealEstateListing JSON-LD.
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/objekt/12345-zurich-3-zimmer' })
      .reply(200, REL);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('schemaorg');
    expect(r.sitemap_url).toBe('https://agency.example/sitemap.xml');
    expect(r.matched_url).toBe('https://agency.example/objekt/12345-zurich-3-zimmer');
  });

  it('walks a sitemap index to find a child sitemap with detail URLs', async () => {
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/robots.txt' })
      .reply(200, 'User-agent: *\nSitemap: https://agency.example/sitemap_index.xml\n');
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap_index.xml' })
      .reply(200, SITEMAP_INDEX);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap-objekte.xml' })
      .reply(200, SITEMAP_OBJEKTE);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/objekt/789-wohnung' })
      .reply(200, REL);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('schemaorg');
    expect(r.sitemap_url).toBe('https://agency.example/sitemap_index.xml');
    expect(r.matched_url).toBe('https://agency.example/objekt/789-wohnung');
  });

  it('returns custom with sitemap_url when detail page also fails to match', async () => {
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/sitemap.xml' }).reply(200, SITEMAP_URLSET);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/objekt/12345-zurich-3-zimmer' })
      .reply(200, '<html><body>no useful markers</body></html>');
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('custom');
    expect(r.sitemap_url).toBe('https://agency.example/sitemap.xml');
    expect(r.matched_url).toBe('https://agency.example/objekt/12345-zurich-3-zimmer');
  });

  it('returns custom with no sitemap when none can be discovered', async () => {
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/sitemap.xml' }).reply(404, '');
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap_index.xml' })
      .reply(404, '');
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('custom');
    expect(r.sitemap_url).toBeUndefined();
  });
});
