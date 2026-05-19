import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommuteCache, quantize, normalizeAddress } from '../src/cache.js';

function freshDb() {
  const db = new Database(':memory:');
  const migrations = ['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql'];
  for (const f of migrations) {
    db.exec(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

describe('quantize', () => {
  it('rounds to N decimals', () => {
    expect(quantize(47.367412345, 4)).toBe(47.3674);
    expect(quantize(8.539987, 4)).toBe(8.54);
  });
});

describe('normalizeAddress', () => {
  it('lowercases + collapses whitespace + trims', () => {
    expect(normalizeAddress('  Brandschenkestrasse 178,  8002   Zürich  ')).toBe('brandschenkestrasse 178, 8002 zürich');
  });
});

describe('CommuteCache', () => {
  let db: ReturnType<typeof freshDb>;
  let cache: CommuteCache;

  beforeEach(() => {
    db = freshDb();
    cache = new CommuteCache(db, 4);
  });

  it('returns undefined on miss', () => {
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });

  it('persists and retrieves a commute row', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date(2026, 4, 18) });
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toMatchObject({ durationS: 1500, distanceM: 8000 });
  });

  it('quantizes coords for cache key', () => {
    cache.upsertCommute({
      from: [47.3674123, 8.5400123], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    const r = cache.getCommute({
      from: [47.3674456, 8.5400456], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r?.durationS).toBe(1500);
  });

  it('different mode → cache miss', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'cycling', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });

  it('persists and retrieves geocode rows', () => {
    cache.upsertGeocode('brandschenkestrasse 178, 8002 zürich', { lat: 47.367, lng: 8.540 }, new Date());
    const r = cache.getGeocode('brandschenkestrasse 178, 8002 zürich');
    expect(r).toMatchObject({ lat: 47.367, lng: 8.540 });
  });

  it('returns undefined for unknown geocode address', () => {
    expect(cache.getGeocode('nope')).toBeUndefined();
  });

  it('clear() empties the commute table', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    cache.clear();
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });
});
