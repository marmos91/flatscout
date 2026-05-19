import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/client.js';
import { migrate } from '../src/migrate.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-db-'));
  dbPath = join(dir, 'test.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('migrations + schema', () => {
  it('applies the init migration cleanly and is idempotent', () => {
    const db = openDb(dbPath);
    const first = migrate(db);
    expect(first.applied).toEqual(['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql']);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
  });

  it('creates listings table with expected columns', () => {
    const db = openDb(dbPath);
    migrate(db);
    const cols = db._raw.prepare('PRAGMA table_info(listings)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    // NOTE: deviated from plan — Phase A adds canonical_key, source_priority, seen_on_sources columns.
    expect(names).toEqual(
      [
        'blocked_reason',
        'canonical_key',
        'fingerprint',
        'first_seen_at',
        'id',
        'last_seen_at',
        'payload',
        'seen_on_sources',
        'source',
        'source_priority',
        'status',
        'url',
      ].sort(),
    );
  });

  it('inserts and retrieves a listing via Drizzle', () => {
    const db = openDb(dbPath);
    migrate(db);
    const now = Date.now();
    db._raw
      .prepare(
        'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        'flatfox:1',
        'flatfox',
        'https://x.example/1',
        'flatfox:1',
        JSON.stringify({ a: 1 }),
        now,
        now,
        'new',
      );
    const row = db._raw.prepare<[], { id: string }>('SELECT id FROM listings').get();
    expect(row?.id).toBe('flatfox:1');
  });

  it('listings_fts virtual table exists', () => {
    const db = openDb(dbPath);
    migrate(db);
    const rows = db._raw.prepare(`SELECT name FROM sqlite_master WHERE name='listings_fts'`).all();
    expect(rows.length).toBeGreaterThan(0);
  });
});
