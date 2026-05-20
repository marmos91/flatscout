import { describe, expect, it } from 'vitest';
import { Listing } from '@wabe/core';
import { shouldNotify } from '../src/canonical-dedup.js';
import type { UpsertResult } from '../src/dedupe.js';

function listing(seen: string[], source: string): Listing {
  return Listing.parse({
    id: 'ck-abc',
    source,
    source_priority: 80,
    url: 'https://example.ch/1',
    canonical_key: 'ck-abc',
    seen_on_sources: seen,
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: '8008',
      city: 'Zürich',
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
  });
}

const isNew: UpsertResult = { changed: true, isNew: true, fingerprint: 'ck-abc' };
const existing: UpsertResult = { changed: true, isNew: false, fingerprint: 'ck-abc' };

describe('shouldNotify', () => {
  it('fires once on isNew=true (suppress=false, also_seen_on=[])', () => {
    const v = shouldNotify(isNew, listing(['source-flatfox'], 'source-flatfox'));
    expect(v).toEqual({ suppress: false, also_seen_on: [] });
  });

  it('suppresses on isNew=false and reports other sources', () => {
    const v = shouldNotify(existing, listing(['source-flatfox', 'source-realadvisor'], 'source-flatfox'));
    expect(v.suppress).toBe(true);
    expect(v.also_seen_on).toEqual(['source-realadvisor']);
  });

  it('strips authoritative source from also_seen_on', () => {
    const v = shouldNotify(existing, listing(['source-flatfox', 'source-homegate'], 'source-flatfox'));
    expect(v.also_seen_on).toEqual(['source-homegate']);
  });
});
