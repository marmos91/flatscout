import { describe, expect, it } from 'vitest';
import { mapEntry, parseGeo } from '../src/map.js';

describe('parseGeo', () => {
  it('parses ZIP + locality + canton', () => {
    expect(parseGeo('8008 Zürich, ZH')).toEqual({ postal_code: '8008', locality: 'Zürich', canton: 'ZH' });
  });
  it('returns nulls on unparseable input', () => {
    expect(parseGeo('garbage')).toEqual({ postal_code: null, locality: null, canton: null });
    expect(parseGeo(null)).toEqual({ postal_code: null, locality: null, canton: null });
  });
});

describe('mapEntry', () => {
  it('maps a sitemap entry to a URL-only RawListing with geo + thumbnail', () => {
    const out = mapEntry({
      loc: 'https://www.immoscout24.ch/rent/4002256697',
      lastmod: '2026-05-17T08:00:00Z',
      image_loc: 'https://cdn.example/img.jpg',
      geo_location: '8008 Zürich, ZH',
    });
    expect(out?.id).toBe('immoscout24:4002256697');
    expect(out?.source).toBe('source-immoscout24-sitemap');
    expect(out?.url).toContain('/rent/4002256697');
    expect(out?.location.postal_code).toBe('8008');
    expect(out?.photos).toEqual(['https://cdn.example/img.jpg']);
    expect(out?.rooms).toBeNull();
    expect(out?.price.total).toBeNull();
  });
});
