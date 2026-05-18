import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/migrate.js';

describe('0002_dedup_fields', () => {
  it('adds canonical_key, source_priority, seen_on_sources columns', () => {
    const raw = new Database(':memory:');
    const db = { _raw: raw } as Parameters<typeof migrate>[0];
    migrate(db);
    const cols = raw.prepare("PRAGMA table_info('listings')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('canonical_key');
    expect(names).toContain('source_priority');
    expect(names).toContain('seen_on_sources');
    const idx = raw.prepare("PRAGMA index_list('listings')").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('idx_listings_canonical_key');
  });
});
