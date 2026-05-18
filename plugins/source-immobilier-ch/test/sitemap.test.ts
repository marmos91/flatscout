import { describe, expect, it } from 'vitest';
import { parseUrlset } from '../src/sitemap.js';

describe('parseUrlset', () => {
  it('parses urlset with loc + lastmod', () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345</loc><lastmod>2026-05-17</lastmod></url>
</urlset>`;
    const out = parseUrlset(xml);
    expect(out).toEqual([
      { loc: 'https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345', lastmod: '2026-05-17' },
    ]);
  });
});
