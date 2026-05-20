import { z } from 'zod';
import type { FlatfoxApiResult } from './map.js';

/** Geographic anchor + radius filter applied client-side using haversine distance. */
export const NearFilter = z.object({
  lat: z.number(),
  lon: z.number(),
  radius_m: z.number().int().positive(),
});
export type NearFilter = z.infer<typeof NearFilter>;

/** User-facing Flatfox search criteria. Only `status`, `limit`, `offset` are sent to the API — the rest are applied client-side. */
export const SearchConfig = z.object({
  status: z.string().default('act'),
  cities: z.array(z.string()).default([]),
  /**
   * Client-side PLZ allowlist. Empty array disables the filter. Flatfox's
   * public listing endpoint exposes no zipcode parameter, so the filter runs
   * after the JSON response lands. Mapped to `Listing.location.postal_code`
   * via `r.zipcode`; null-zip listings are dropped when the allowlist is set.
   */
  zipcodes: z
    .array(z.string().regex(/^\d{4}$/, 'PLZ must be a 4-digit Swiss postal code'))
    .default([]),
  price_max: z.number().int().positive().optional(),
  price_min: z.number().int().positive().optional(),
  rooms_min: z.number().optional(),
  rooms_max: z.number().optional(),
  surface_min: z.number().int().positive().optional(),
  offer_type: z.string().default('RENT'),
  category: z.string().default('APARTMENT'),
  near: NearFilter.optional(),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance in meters between two lat/lon points (haversine).
 * Inputs in decimal degrees. Returns +Infinity if either point is missing.
 */
export function haversineMeters(
  a: { lat: number; lon: number } | null | undefined,
  b: { lat: number; lon: number } | null | undefined,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Builds the URL query string for the Flatfox listing endpoint (status + pagination only). */
export function buildQuery(cfg: SearchConfig, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set('status', cfg.status);
  p.set('limit', String(limit));
  p.set('offset', String(offset));
  return p.toString();
}

/**
 * Applies the user's search criteria client-side, since the public Flatfox API
 * does not expose price/rooms/area parameters. Items missing a comparable
 * field are conservatively rejected (e.g. items without `price_display` fail
 * `price_max`).
 */
export function applyClientFilters(items: FlatfoxApiResult[], cfg: SearchConfig): FlatfoxApiResult[] {
  return items.filter((r) => {
    if (cfg.cities.length > 0 && r.city && !cfg.cities.includes(r.city)) return false;
    if (cfg.zipcodes.length > 0) {
      // r.zipcode is a number on the API; coerce to string for comparison.
      const plz = r.zipcode != null ? String(r.zipcode) : null;
      if (!plz || !cfg.zipcodes.includes(plz)) return false;
    }
    const price = r.price_display ?? Number.POSITIVE_INFINITY;
    if (cfg.price_max != null && price > cfg.price_max) return false;
    if (cfg.price_min != null && price < cfg.price_min) return false;
    const rooms =
      typeof r.number_of_rooms === 'string' ? Number.parseFloat(r.number_of_rooms) : (r.number_of_rooms ?? 0);
    if (cfg.rooms_min != null && rooms < cfg.rooms_min) return false;
    if (cfg.rooms_max != null && rooms > cfg.rooms_max) return false;
    if (cfg.surface_min != null && (r.surface_living ?? 0) < cfg.surface_min) return false;
    if (cfg.offer_type && r.offer_type && r.offer_type !== cfg.offer_type) return false;
    if (cfg.category && r.object_category && r.object_category !== cfg.category) return false;
    if (cfg.near) {
      if (r.latitude == null || r.longitude == null) return false;
      const d = haversineMeters(cfg.near, { lat: r.latitude, lon: r.longitude });
      if (d > cfg.near.radius_m) return false;
    }
    return true;
  });
}
