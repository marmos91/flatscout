import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type WabeDb } from '@wabe/db';
import { Listing } from '@wabe/core';
import { upsertListing } from '../src/dedupe.js';

// NOTE: deviated from plan — plan imported `better-sqlite3` directly, but the server
// package only depends on it transitively via @wabe/db. Using `openDb` (which the
// rest of the server test suite already uses) keeps the dependency graph clean.
let dir: string;
function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-dedupe-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return db;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeListing(over: Partial<Listing> & { id: string; source: string; url: string }): Listing {
  return Listing.parse({
    id: over.id,
    source: over.source,
    url: over.url,
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
    ...over,
  });
}

describe('upsertListing canonical-group merging', () => {
  it('merges seen_on_sources across two rows sharing a canonical_key', () => {
    const db = freshDb();
    upsertListing(db, makeListing({ id: 'a:1', source: 'source-flatfox', url: 'https://flatfox.ch/1' }));
    upsertListing(db, makeListing({ id: 'b:1', source: 'source-homegate', url: 'https://homegate.ch/1' }));
    const rows = db._raw.prepare('SELECT id, seen_on_sources FROM listings ORDER BY id').all() as Array<{
      id: string;
      seen_on_sources: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(JSON.parse(r.seen_on_sources).sort()).toEqual(['source-flatfox', 'source-homegate']);
    }
  });
});
