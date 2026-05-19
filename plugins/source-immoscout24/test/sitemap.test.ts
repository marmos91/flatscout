import { describe, expect, it } from 'vitest';
import { parseUrlset } from '../src/sitemap.js';

describe('parseUrlset', () => {
  it('parses urlset with image:loc + geo_location', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://www.immoscout24.ch/rent/4002256697</loc>
    <lastmod>2026-05-17T08:00:00Z</lastmod>
    <image:image>
      <image:loc>https://cdn.example/img.jpg</image:loc>
      <image:geo_location>8008 Zürich, ZH</image:geo_location>
    </image:image>
  </url>
</urlset>`;
    const out = parseUrlset(xml);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      loc: 'https://www.immoscout24.ch/rent/4002256697',
      lastmod: '2026-05-17T08:00:00Z',
      image_loc: 'https://cdn.example/img.jpg',
      geo_location: '8008 Zürich, ZH',
    });
  });
});
