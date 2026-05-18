import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type WabeDb } from '@wabe/db';
import { canonicalKey, Listing } from '@wabe/core';
import { upsertListing } from '../src/dedupe.js';
import { shouldNotify } from '../src/canonical-dedup.js';

// NOTE: deviated from plan — plan imported `better-sqlite3` directly; using openDb from @wabe/db
// matches the rest of the server test suite and keeps server's dep graph clean.
let dir: string;
function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-canon-dedup-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return db;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// NOTE: deviated from plan — fixture stamps canonical_key so the test mirrors the pipeline
// (Task 6), which computes canonical_key on the listing object before invoking shouldNotify.
function fixture(id: string, source: string, sourcePriority: number, url: string): Listing {
  const ck = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 112, price_total: 3200, url });
  return Listing.parse({
    id,
    source,
    source_priority: sourcePriority,
    canonical_key: ck,
    url,
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
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

describe('shouldNotify', () => {
  it('notifies first arrival in a group with no other sources listed', () => {
    const db = freshDb();
    const l = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, l);
    const v = shouldNotify(db, l);
    expect(v.suppress).toBe(false);
    expect(v.also_seen_on).toEqual([]);
  });
  it('suppresses lower-priority arrival when a higher-priority listing already exists in the group', () => {
    const db = freshDb();
    const flatfox = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, flatfox);
    const realadvisor = fixture('b:1', 'source-realadvisor', 50, 'https://realadvisor.ch/1');
    upsertListing(db, realadvisor);
    const v = shouldNotify(db, realadvisor);
    expect(v.suppress).toBe(true);
  });
  it('notifies higher-priority arrival even when a lower-priority listing exists in the group', () => {
    const db = freshDb();
    const realadvisor = fixture('b:1', 'source-realadvisor', 50, 'https://realadvisor.ch/1');
    upsertListing(db, realadvisor);
    const flatfox = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, flatfox);
    const v = shouldNotify(db, flatfox);
    expect(v.suppress).toBe(false);
    expect(v.also_seen_on).toContain('source-realadvisor');
  });
});
