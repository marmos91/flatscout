import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalKey, SOURCE_PRIORITY_DEFAULTS } from '@wabe/core';
import { openDb, migrate, collapseListings, type WabeDb } from '../src/index.js';

let dir: string | undefined;
function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-collapse-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return db;
}
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

interface SeedLegacyRow {
  id: string;
  source: string;
  url: string;
  canonical_key: string;
  source_priority: number;
  first_seen_at: number;
  description?: string | null;
}

function legacyPayload(row: SeedLegacyRow): string {
  return JSON.stringify({
    id: row.id,
    source: row.source,
    source_priority: row.source_priority,
    url: row.url,
    canonical_key: row.canonical_key,
    first_seen_at: new Date(row.first_seen_at).toISOString(),
    last_seen_at: new Date(row.first_seen_at).toISOString(),
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
    description: row.description ?? null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
    seen_on_sources: [row.source],
  });
}

function seedLegacyState(db: WabeDb, legacyRows: SeedLegacyRow[]): void {
  const raw = db._raw;
  // Recreate the pre-collapse table shape so the runner can read it.
  raw.exec('DROP TABLE IF EXISTS listings_old');
  raw.exec(`
    CREATE TABLE listings_old (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      url             TEXT NOT NULL,
      fingerprint     TEXT NOT NULL,
      payload         TEXT NOT NULL,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'new',
      blocked_reason  TEXT,
      canonical_key   TEXT NOT NULL DEFAULT '',
      source_priority INTEGER NOT NULL DEFAULT 50,
      seen_on_sources TEXT NOT NULL DEFAULT '[]'
    );
  `);
  const ins = raw.prepare(
    'INSERT INTO listings_old (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const r of legacyRows) {
    ins.run(
      r.id,
      r.source,
      r.url,
      r.id,
      legacyPayload(r),
      r.first_seen_at,
      r.first_seen_at,
      'new',
      r.canonical_key,
      r.source_priority,
      JSON.stringify([r.source]),
    );
  }
}

describe('collapseListings runner', () => {
  it('folds three rows sharing a canonical_key into one, repoints score FKs, drops listings_old', () => {
    const db = freshDb();

    const ck = canonicalKey({
      postal_code: '8008',
      rooms: 4.5,
      area_m2: 112,
      price_total: 3200,
      url: 'https://flatfox.ch/1',
    });

    seedLegacyState(db, [
      {
        id: 'flatfox:1',
        source: 'source-flatfox',
        url: 'https://flatfox.ch/1',
        canonical_key: ck,
        source_priority: SOURCE_PRIORITY_DEFAULTS['source-flatfox'] ?? 80,
        first_seen_at: 1_700_000_000_000,
        description: 'flatfox copy',
      },
      {
        id: 'realadvisor:2',
        source: 'source-realadvisor',
        url: 'https://realadvisor.ch/2',
        canonical_key: ck,
        source_priority: 50,
        first_seen_at: 1_700_000_100_000,
      },
      {
        id: 'homegate:3',
        source: 'source-homegate',
        url: 'https://homegate.ch/3',
        canonical_key: ck,
        source_priority: 70,
        first_seen_at: 1_700_000_200_000,
      },
    ]);

    // Seed scores_old so we can verify FK repoint.
    db._raw.exec(`
      CREATE TABLE IF NOT EXISTS scores_old (
        listing_id TEXT NOT NULL,
        scored_at INTEGER NOT NULL,
        final INTEGER NOT NULL,
        breakdown TEXT NOT NULL,
        PRIMARY KEY (listing_id, scored_at)
      );
    `);
    db._raw
      .prepare('INSERT INTO scores_old (listing_id, scored_at, final, breakdown) VALUES (?,?,?,?)')
      .run('realadvisor:2', 1_700_000_100_000, 50, '{}');

    collapseListings(db);

    const rows = db._raw
      .prepare<[], { id: string; source: string; source_priority: number; seen_on_sources: string }>(
        'SELECT id, source, source_priority, seen_on_sources FROM listings',
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ck);
    expect(rows[0]?.source).toBe('source-flatfox');
    expect(JSON.parse(rows[0]?.seen_on_sources ?? '[]').sort()).toEqual([
      'source-flatfox',
      'source-homegate',
      'source-realadvisor',
    ]);

    const score = db._raw.prepare<[], { listing_id: string }>('SELECT listing_id FROM scores').get();
    expect(score?.listing_id).toBe(ck);

    const old = db._raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings_old'")
      .get();
    expect(old).toBeUndefined();
  });

  it('is idempotent — re-running with no listings_old is a no-op', () => {
    const db = freshDb();
    // After migrate(db), 0005 already ran and listings_old has been dropped.
    expect(() => collapseListings(db)).not.toThrow();
    expect(db._raw.prepare('SELECT COUNT(*) AS n FROM listings').get()).toEqual({ n: 0 });
  });
});
