import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { fingerprint, scoreDetailUrl } from '../src/index.js';

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

  it('fans out across sibling child sitemaps when the top-ranked branch lacks listings', async () => {
    // Single-development site: sitemap-index lists `pages.xml` (high-ranking
    // generic pages first by score) AND `wohnpark.xml` (the listings). With
    // single-pick logic the picker would walk into pages.xml and never see
    // the real units. Fan-out must also fetch wohnpark.xml.
    const indexXml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://agency.example/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://agency.example/sitemap-wohnpark.xml</loc></sitemap>
</sitemapindex>`;
    const pagesXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agency.example/impressum</loc></url>
  <url><loc>https://agency.example/datenschutz</loc></url>
</urlset>`;
    const wohnparkXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agency.example/wohnpark/a23-3-zimmer-wohnung</loc></url>
</urlset>`;
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap.xml' })
      .reply(200, indexXml);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap-pages.xml' })
      .reply(200, pagesXml);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap-wohnpark.xml' })
      .reply(200, wohnparkXml);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/wohnpark/a23-3-zimmer-wohnung' })
      .reply(200, REL);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('schemaorg');
    expect(r.matched_url).toBe('https://agency.example/wohnpark/a23-3-zimmer-wohnung');
  });

  it('returns custom with sitemap_url when detail page also fails to match', async () => {
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap.xml' })
      .reply(200, SITEMAP_URLSET);
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/objekt/12345-zurich-3-zimmer' })
      .reply(200, '<html><body>no useful markers</body></html>');
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('custom');
    expect(r.sitemap_url).toBe('https://agency.example/sitemap.xml');
    expect(r.matched_url).toBe('https://agency.example/objekt/12345-zurich-3-zimmer');
  });

  it('tries multiple ranked detail candidates and short-circuits on first heuristic hit', async () => {
    // Sitemap urlset with a category page, an off-CH locale page, and a real
    // detail page. The picker must rank the detail page above the others so
    // we never even fetch them.
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/' }).reply(200, ORG);
    agent.get('https://agency.example').intercept({ method: 'GET', path: '/robots.txt' }).reply(404, '');
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/sitemap.xml' })
      .reply(
        200,
        `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agency.example/de-de/mehrfamilienhaus-bewerten/potenzialanalyse</loc></url>
  <url><loc>https://agency.example/de/mieten-kaufen/alle-mietobjekte.html</loc></url>
  <url><loc>https://agency.example/objekt/12345-zurich-3-zimmer-wohnung</loc></url>
</urlset>`,
      );
    agent
      .get('https://agency.example')
      .intercept({ method: 'GET', path: '/objekt/12345-zurich-3-zimmer-wohnung' })
      .reply(200, REL);
    const r = await fingerprint('https://agency.example/', new AbortController().signal);
    expect(r.platform).toBe('schemaorg');
    expect(r.matched_url).toBe('https://agency.example/objekt/12345-zurich-3-zimmer-wohnung');
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

describe('scoreDetailUrl', () => {
  it('prefers strong-hint detail URLs over category indexes', () => {
    const detail = scoreDetailUrl('https://x.ch/objekt/12345-zurich-3-zimmer-wohnung');
    const category = scoreDetailUrl('https://x.ch/de/mieten-kaufen/alle-mietobjekte.html');
    expect(detail).toBeGreaterThan(category);
  });
  it('penalizes foreign-locale paths', () => {
    const ch = scoreDetailUrl('https://x.ch/de-ch/objekt/123');
    const de = scoreDetailUrl('https://x.ch/de-de/objekt/123');
    expect(ch).toBeGreaterThan(de);
  });
  it('penalizes vacation/blog/services segments', () => {
    expect(scoreDetailUrl('https://x.ch/ferienimmobilien/listings/foo')).toBeLessThan(
      scoreDetailUrl('https://x.ch/listing/foo-12345'),
    );
    expect(scoreDetailUrl('https://x.ch/de/leistungen/immobilienbewirtschaftung.html')).toBeLessThan(
      scoreDetailUrl('https://x.ch/immobilien/villa-zollikon-90123'),
    );
  });
  it('keeps a single-segment listing-typed page positive (model-unit case)', () => {
    expect(scoreDetailUrl('https://halohomes.ch/musterwohnung/')).toBeGreaterThan(0);
  });
});
