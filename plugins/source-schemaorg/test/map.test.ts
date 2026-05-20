import { describe, expect, it } from 'vitest';
import { mapDetail } from '../src/map.js';
import type { ExtractedListing } from '../src/extract.js';

describe('mapDetail', () => {
  it('maps a jsonld-tier ExtractedListing into RawListing', () => {
    const extracted: ExtractedListing = {
      tier: 'jsonld',
      title: 'Nice flat',
      description: 'A flat',
      url: 'https://walde.ch/object-12345',
      photos: ['https://walde.ch/i.jpg'],
      price_chf: 2400,
      currency: 'CHF',
      rooms: 3.5,
      area_m2: 95,
      address: { street: 'Bahnhofstr. 1', postal_code: '8008', city: 'Zürich', region: null },
      geo: { lat: null, lon: null },
    };
    const out = mapDetail('walde', 'https://walde.ch/object-12345', extracted);
    expect(out?.id).toBe('agency:walde:12345');
    expect(out?.source).toBe('agency:schemaorg:walde');
    expect(out?.rooms).toBe(3.5);
    expect(out?.area_m2).toBe(95);
    expect(out?.price.total).toBe(2400);
    expect(out?.location.postal_code).toBe('8008');
    expect(out?.agency).toBe('walde');
    expect((out?.enriched as { extraction_tier?: string }).extraction_tier).toBe('jsonld');
  });

  it('returns null when extraction missed', () => {
    expect(mapDetail('walde', 'https://walde.ch/x', null)).toBeNull();
  });

  it('preserves opengraph-regex tier marker', () => {
    const extracted: ExtractedListing = {
      tier: 'opengraph-regex',
      title: 't',
      description: null,
      url: 'https://x.ch/y-42',
      photos: [],
      price_chf: 3200,
      currency: 'CHF',
      rooms: 4,
      area_m2: null,
      address: { street: null, postal_code: null, city: null, region: null },
      geo: { lat: null, lon: null },
    };
    const out = mapDetail('x', 'https://x.ch/y-42', extracted);
    expect((out?.enriched as { extraction_tier?: string }).extraction_tier).toBe('opengraph-regex');
  });
});
