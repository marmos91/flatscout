import type Database from 'better-sqlite3';
import type { CommuteMode } from '@wabe/core';

export type Coord = [number, number]; // [lat, lng]
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface CommuteKey {
  from: Coord;
  target: string;
  mode: CommuteMode;
  weekday: Weekday;
  arriveByMin: number;
}

export interface CommuteRow {
  durationS: number;
  distanceM: number;
  computedAt: Date;
}

export interface GeocodeRow {
  lat: number;
  lng: number;
  computedAt: Date;
}

export function quantize(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function normalizeAddress(addr: string): string {
  return addr.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class CommuteCache {
  constructor(
    private readonly db: Database.Database,
    private readonly decimals: number,
  ) {}

  getCommute(key: CommuteKey): CommuteRow | undefined {
    const lat: number = key.from[0];
    const lng: number = key.from[1];
    const row = this.db
      .prepare(
        `SELECT duration_s, distance_m, computed_at FROM commute_cache
         WHERE from_lat_q = ? AND from_lng_q = ? AND to_target = ? AND mode = ?
           AND weekday = ? AND arrive_by_min = ?`,
      )
      .get(
        quantize(lat, this.decimals),
        quantize(lng, this.decimals),
        key.target,
        key.mode,
        key.weekday,
        key.arriveByMin,
      ) as { duration_s: number; distance_m: number; computed_at: number } | undefined;
    if (!row) return undefined;
    return {
      durationS: row.duration_s,
      distanceM: row.distance_m,
      computedAt: new Date(row.computed_at),
    };
  }

  upsertCommute(key: CommuteKey, val: CommuteRow): void {
    const lat: number = key.from[0];
    const lng: number = key.from[1];
    this.db
      .prepare(
        `INSERT OR REPLACE INTO commute_cache
         (from_lat_q, from_lng_q, to_target, mode, weekday, arrive_by_min, duration_s, distance_m, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        quantize(lat, this.decimals),
        quantize(lng, this.decimals),
        key.target,
        key.mode,
        key.weekday,
        key.arriveByMin,
        val.durationS,
        val.distanceM,
        val.computedAt.getTime(),
      );
  }

  getGeocode(addressNorm: string): GeocodeRow | undefined {
    const row = this.db
      .prepare('SELECT lat, lng, computed_at FROM geocode_cache WHERE address_norm = ?')
      .get(addressNorm) as { lat: number; lng: number; computed_at: number } | undefined;
    if (!row) return undefined;
    return { lat: row.lat, lng: row.lng, computedAt: new Date(row.computed_at) };
  }

  upsertGeocode(addressNorm: string, coords: { lat: number; lng: number }, computedAt: Date): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO geocode_cache (address_norm, lat, lng, computed_at)
         VALUES (?,?,?,?)`,
      )
      .run(addressNorm, coords.lat, coords.lng, computedAt.getTime());
  }

  clear(): void {
    this.db.exec('DELETE FROM commute_cache; DELETE FROM geocode_cache;');
  }
}
