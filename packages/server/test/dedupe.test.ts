import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type FlatscoutDb } from '@flatscout/db';
import { canonicalKey } from '@flatscout/core';
import type { RawListing } from '@flatscout/core';
import { mergeUpsertCanonical, readListing, writeListingPayload } from '../src/dedupe.js';

let dir: string;
function freshDb(): FlatscoutDb {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-dedup-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return db;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function raw(overrides: Partial<RawListing> & Pick<RawListing, 'source' | 'url'>): RawListing {
  return {
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
  };
}

function ck(r: RawListing): string {
  return canonicalKey({
    postal_code: r.location?.postal_code ?? null,
    rooms: r.rooms ?? null,
    area_m2: r.area_m2 ?? null,
    price_total: r.price?.total ?? null,
    url: r.url,
  });
}

describe('mergeUpsertCanonical — first arrival', () => {
  it('inserts a fresh row with id = canonical_key and seen_on_sources = [source]', () => {
    const db = freshDb();
    const r = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(r);

    const res = mergeUpsertCanonical(db, r, k, 80);

    expect(res.isNew).toBe(true);
    expect(res.changed).toBe(true);
    const merged = readListing(db, k);
    expect(merged?.id).toBe(k);
    expect(merged?.source).toBe('source-flatfox');
    expect(merged?.source_priority).toBe(80);
    expect(merged?.seen_on_sources).toEqual(['source-flatfox']);
  });
});

describe('mergeUpsertCanonical — second source merge', () => {
  it('lower-priority second source fills null fields, unions photos, isNew=false', () => {
    const db = freshDb();
    const ff = raw({
      source: 'source-flatfox',
      url: 'https://flatfox.ch/1',
      description: 'flatfox copy',
      photos: ['https://flatfox.ch/a.jpg'],
    });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);

    const ra = raw({
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      contact: { phone: '+41 44 000 00 00' },
      photos: ['https://ra.ch/x.jpg'],
      description: null,
    });
    const res = mergeUpsertCanonical(db, ra, k, 50);

    expect(res.isNew).toBe(false);
    expect(res.changed).toBe(true);
    const merged = readListing(db, k);
    expect(merged?.source).toBe('source-flatfox');
    expect(merged?.contact.phone).toBe('+41 44 000 00 00');
    expect(merged?.photos).toEqual(['https://flatfox.ch/a.jpg', 'https://ra.ch/x.jpg']);
    expect(merged?.seen_on_sources).toEqual(['source-flatfox', 'source-realadvisor']);
  });

  it('higher-priority second source flips authoritative source/url/priority', () => {
    const db = freshDb();
    const ra = raw({ source: 'source-realadvisor', url: 'https://realadvisor.ch/2' });
    const k = ck(ra);
    mergeUpsertCanonical(db, ra, k, 50);

    const ff = raw({
      source: 'source-flatfox',
      url: 'https://flatfox.ch/1',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
    });
    mergeUpsertCanonical(db, ff, k, 80);

    const merged = readListing(db, k);
    expect(merged?.source).toBe('source-flatfox');
    expect(merged?.url).toBe('https://flatfox.ch/1');
    expect(merged?.source_priority).toBe(80);
  });

  it('same payload from same source is a no-op (changed=false, isNew=false)', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const res = mergeUpsertCanonical(db, ff, k, 80);
    expect(res).toEqual({ isNew: false, changed: false, fingerprint: k });
  });

  it('external_ids accumulate across sources', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1', id: 'flatfox:ff-1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const ra = raw({
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      id: 'realadvisor:ra-2',
    });
    mergeUpsertCanonical(db, ra, k, 50);

    const merged = readListing(db, k);
    expect(merged?.enriched.external_ids).toEqual({
      'source-flatfox': 'flatfox:ff-1',
      'source-realadvisor': 'realadvisor:ra-2',
    });
  });
});

describe('writeListingPayload — enricher persistence', () => {
  it('overwrites payload + last_seen_at without altering seen_on_sources', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const merged = readListing(db, k);
    if (!merged) throw new Error('missing merged row');
    merged.enriched = { ...merged.enriched, commute: { home: { duration_s: 900 } } };
    writeListingPayload(db, merged);

    const after = readListing(db, k);
    expect((after?.enriched.commute as Record<string, unknown>).home).toEqual({ duration_s: 900 });
    expect(after?.seen_on_sources).toEqual(['source-flatfox']);
  });
});
