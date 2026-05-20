import { describe, it, expect } from 'vitest';
import { resolveFields } from '../src/merge.js';
import { Listing, type RawListing } from '../src/schemas/listing.js';

function baseExisting(overrides: Partial<unknown> = {}): Listing {
  return Listing.parse({
    id: 'ck-abc',
    source: 'source-flatfox',
    source_priority: 80,
    url: 'https://flatfox.ch/1',
    canonical_key: 'ck-abc',
    seen_on_sources: ['source-flatfox'],
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
    ...overrides,
  });
}

describe('resolveFields — priority-wins + null-skip', () => {
  it('lower-priority source fills null fields without overwriting non-null ones', () => {
    const existing = baseExisting({ description: 'flatfox copy' });
    const raw: RawListing = {
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: 2800, extras: 400, total: 3200, currency: 'CHF', deposit_months: 2 },
      rooms: 4.5,
      area_m2: 112,
      floor: null,
      total_floors: null,
      built_year: null,
      renovated_year: null,
      location: {
        coords: null,
        address: 'Seefeldstrasse 1',
        postal_code: '8008',
        city: 'Zürich',
        region: null,
        country: 'CH',
        neighborhood: null,
      },
      features: {},
      description: 'different copy',
      photos: [],
      available_from: null,
      lease_until: null,
      rental_term: 'unknown',
      agency: null,
      contact: {},
      enriched: {},
      extra: {},
    };

    const { next, changed } = resolveFields(existing, raw, 50);

    expect(next.source).toBe('source-flatfox');
    expect(next.url).toBe('https://flatfox.ch/1');
    expect(next.source_priority).toBe(80);
    expect(next.description).toBe('flatfox copy');
    expect(next.price.rent_net).toBe(2800);
    expect(next.price.extras).toBe(400);
    expect(next.price.deposit_months).toBe(2);
    expect(next.location.address).toBe('Seefeldstrasse 1');
    expect(next.seen_on_sources).toEqual(['source-flatfox', 'source-realadvisor']);
    expect(changed).toBe(true);
  });
});

describe('resolveFields — authoritative switch on higher priority', () => {
  it('higher-priority incoming flips source/url/priority; existing non-null fields kept where incoming has nulls', () => {
    const existing = baseExisting({
      source: 'source-realadvisor',
      source_priority: 50,
      url: 'https://realadvisor.ch/2',
      description: 'realadvisor copy',
      contact: { phone: '+41 44 000 00 00', email: null, form_url: null },
      seen_on_sources: ['source-realadvisor'],
    });
    const raw: RawListing = {
      source: 'source-flatfox',
      url: 'https://flatfox.ch/1',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
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
    };
    const { next } = resolveFields(existing, raw, 80);
    expect(next.source).toBe('source-flatfox');
    expect(next.url).toBe('https://flatfox.ch/1');
    expect(next.source_priority).toBe(80);
    expect(next.description).toBe('realadvisor copy');
    expect(next.contact.phone).toBe('+41 44 000 00 00');
  });
});

describe('resolveFields — ties broken by first_seen_at (older wins)', () => {
  it('same priority: older first_seen_at remains authoritative', () => {
    const existing = baseExisting({
      source: 'source-homegate',
      source_priority: 70,
      url: 'https://homegate.ch/1',
      first_seen_at: new Date('2026-05-18T10:00:00Z'),
    });
    const raw: RawListing = {
      source: 'source-immoscout24',
      url: 'https://immoscout24.ch/9',
      first_seen_at: new Date('2026-05-19T10:00:00Z'),
      last_seen_at: new Date('2026-05-19T10:00:00Z'),
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
    };
    const { next } = resolveFields(existing, raw, 70);
    expect(next.source).toBe('source-homegate');
    expect(next.url).toBe('https://homegate.ch/1');
  });
});

describe('resolveFields — photos union', () => {
  it('authoritative photos first, then other-source photos, dedup by URL', () => {
    const existing = baseExisting({
      source: 'source-flatfox',
      source_priority: 80,
      photos: ['https://cdn.flatfox.ch/a.jpg', 'https://cdn.flatfox.ch/b.jpg'],
    });
    const raw: RawListing = {
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
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
      photos: ['https://cdn.flatfox.ch/a.jpg', 'https://cdn.ra.ch/x.jpg'],
      available_from: null,
      lease_until: null,
      rental_term: 'unknown',
      agency: null,
      contact: {},
      enriched: {},
      extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.photos).toEqual([
      'https://cdn.flatfox.ch/a.jpg',
      'https://cdn.flatfox.ch/b.jpg',
      'https://cdn.ra.ch/x.jpg',
    ]);
  });
});

describe('resolveFields — rental_term', () => {
  it("'unknown' loses to 'long' regardless of priority", () => {
    const existing = baseExisting({ source: 'source-flatfox', source_priority: 80, rental_term: 'unknown' });
    const raw: RawListing = {
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
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
      rental_term: 'long',
      agency: null,
      contact: {},
      enriched: {},
      extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.rental_term).toBe('long');
  });
});

describe('resolveFields — enriched deep-merge + external_ids', () => {
  it('merges enriched maps with array union and external_ids accumulation', () => {
    const existing = baseExisting({
      source: 'source-flatfox',
      source_priority: 80,
      enriched: {
        commute: { home: { duration_s: 1800 } },
        amenities: ['lift'],
        external_ids: { 'source-flatfox': 'ff-1' },
      },
    });
    const raw: RawListing = {
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
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
      enriched: {
        amenities: ['lift', 'balcony'],
        commute: { office: { duration_s: 600 } },
        external_ids: { 'source-realadvisor': 'ra-2' },
      },
      extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.enriched.amenities).toEqual(expect.arrayContaining(['lift', 'balcony']));
    expect((next.enriched.commute as Record<string, unknown>).home).toEqual({ duration_s: 1800 });
    expect((next.enriched.commute as Record<string, unknown>).office).toEqual({ duration_s: 600 });
    expect(next.enriched.external_ids).toEqual({ 'source-flatfox': 'ff-1', 'source-realadvisor': 'ra-2' });
  });
});

describe('resolveFields — seen_on_sources', () => {
  it('produces a sorted union including the incoming source', () => {
    const existing = baseExisting({ seen_on_sources: ['source-flatfox', 'source-realadvisor'] });
    const raw: RawListing = {
      source: 'source-homegate',
      url: 'https://homegate.ch/1',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
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
    };
    const { next } = resolveFields(existing, raw, 70);
    expect(next.seen_on_sources).toEqual(['source-flatfox', 'source-homegate', 'source-realadvisor']);
  });
});

describe('resolveFields — conservative changed flag', () => {
  it('returns changed=false when payload (excluding last_seen_at) is identical', () => {
    const existing = baseExisting();
    const raw: RawListing = {
      source: existing.source,
      url: existing.url,
      first_seen_at: existing.first_seen_at,
      last_seen_at: new Date(existing.last_seen_at.getTime() + 60_000),
      price: existing.price,
      rooms: existing.rooms,
      area_m2: existing.area_m2,
      floor: existing.floor,
      total_floors: existing.total_floors,
      built_year: existing.built_year,
      renovated_year: existing.renovated_year,
      location: existing.location,
      features: existing.features,
      description: existing.description,
      photos: existing.photos,
      available_from: existing.available_from,
      lease_until: existing.lease_until,
      rental_term: existing.rental_term,
      agency: existing.agency,
      contact: existing.contact,
      enriched: existing.enriched,
      extra: existing.extra,
    };
    const { changed } = resolveFields(existing, raw, existing.source_priority);
    expect(changed).toBe(false);
  });
});
