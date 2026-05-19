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

  it('fills full-detail fields when a JSON-LD detail payload is supplied', () => {
    const detail = {
      listing: {
        '@type': 'RealEstateListing' as const,
        numberOfRooms: 3.5,
        floorSize: { value: 78 },
        offers: { price: 2400, priceCurrency: 'CHF' },
        address: {
          streetAddress: 'Seestrasse 12',
          postalCode: '8002',
          addressLocality: 'Zürich',
          addressRegion: 'ZH',
        },
        description: 'Sunny attic',
        image: ['https://img/1.jpg', 'https://img/2.jpg'],
      },
    };
    const out = mapEntry(
      {
        loc: 'https://www.immoscout24.ch/rent/123',
        lastmod: null,
        image_loc: 'https://cdn.example/old.jpg',
        geo_location: '8002 Zürich, ZH',
      },
      detail,
    );
    expect(out?.rooms).toBe(3.5);
    expect(out?.area_m2).toBe(78);
    expect(out?.price.total).toBe(2400);
    expect(out?.price.currency).toBe('CHF');
    expect(out?.location.address).toBe('Seestrasse 12');
    expect(out?.location.postal_code).toBe('8002');
    expect(out?.description).toBe('Sunny attic');
    expect(out?.photos).toEqual(['https://img/1.jpg', 'https://img/2.jpg']);
  });
});
