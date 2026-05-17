import { describe, expect, it } from 'vitest';
import { Listing } from '../src/schemas/listing.js';

describe('Listing schema', () => {
  it('accepts a minimal listing with nullable fields populated as null', () => {
    const parsed = Listing.parse({
      id: 'flatfox:42',
      source: 'flatfox',
      url: 'https://flatfox.ch/en/flat/42/foo',
      first_seen_at: '2026-05-17T10:00:00Z',
      last_seen_at: '2026-05-17T10:00:00Z',
      price: { rent_net: null, extras: null, total: 2400, currency: 'CHF', deposit_months: null },
      rooms: 3.5,
      area_m2: 85,
      floor: null,
      total_floors: null,
      built_year: null,
      renovated_year: null,
      location: {
        coords: [47.37, 8.54],
        address: null,
        postal_code: null,
        city: 'Zürich',
        region: null,
        country: 'CH',
        neighborhood: null,
      },
      description: null,
      photos: [],
      available_from: null,
      agency: null,
    });
    expect(parsed.id).toBe('flatfox:42');
    expect(parsed.price.currency).toBe('CHF');
    expect(parsed.features).toEqual({});
    expect(parsed.contact).toEqual({});
  });

  it('rejects missing required id', () => {
    expect(() =>
      Listing.parse({ source: 's', url: 'https://x.example/1', first_seen_at: '2026-05-17', last_seen_at: '2026-05-17', price: { rent_net: null, extras: null, total: null, currency: 'CHF', deposit_months: null }, rooms: null, area_m2: null, floor: null, total_floors: null, built_year: null, renovated_year: null, location: { coords: null, address: null, postal_code: null, city: null, region: null, country: 'CH', neighborhood: null }, description: null, photos: [], available_from: null, agency: null }),
    ).toThrow();
  });

  it('defaults country to CH when omitted from location', () => {
    const parsed = Listing.parse({
      id: 'x:1', source: 'x', url: 'https://x.example/1',
      first_seen_at: '2026-05-17T00:00:00Z', last_seen_at: '2026-05-17T00:00:00Z',
      price: { rent_net: null, extras: null, total: 100, currency: 'CHF', deposit_months: null },
      rooms: null, area_m2: null, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: null, city: null, region: null, neighborhood: null },
      description: null, photos: [], available_from: null, agency: null,
    });
    expect(parsed.location.country).toBe('CH');
  });
});
