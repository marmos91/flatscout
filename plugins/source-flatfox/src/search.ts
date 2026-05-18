import { z } from 'zod';
import type { FlatfoxApiResult } from './map.js';

/** User-facing Flatfox search criteria. Only `status`, `limit`, `offset` are sent to the API — the rest are applied client-side. */
export const SearchConfig = z.object({
  status: z.string().default('act'),
  cities: z.array(z.string()).default([]),
  price_max: z.number().int().positive().optional(),
  price_min: z.number().int().positive().optional(),
  rooms_min: z.number().optional(),
  rooms_max: z.number().optional(),
  surface_min: z.number().int().positive().optional(),
  offer_type: z.string().default('RENT'),
  category: z.string().default('APARTMENT'),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

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
    return true;
  });
}
