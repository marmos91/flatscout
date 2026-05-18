import type { RawListing } from '@wabe/core';
import type { SitemapEntry } from './sitemap.js';

/**
 * Sitemap entries yield URL-only listings with geo + thumbnail. Detail fields
 * (rooms/area/price/description) remain null — Phase B's browser bridge
 * promotes this plugin to full-detail by re-fetching each PDP through the
 * extension.
 */
export function mapEntry(e: SitemapEntry): RawListing | null {
  if (!e.loc) return null;
  // immoscout24 detail URL ends with /<id> — use last numeric segment as the id source.
  const idMatch = e.loc.match(/\/(\d+)(?:\?|$)/);
  const id = idMatch ? idMatch[1] : e.loc;
  const geo = parseGeo(e.geo_location);
  return {
    id: `immoscout24:${id}`,
    source: 'source-immoscout24-sitemap',
    url: e.loc,
    price: { rent_net: null, extras: null, total: null, currency: 'CHF', deposit_months: null },
    rooms: null,
    area_m2: null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: geo.postal_code,
      city: geo.locality,
      region: geo.canton,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: e.image_loc ? [e.image_loc] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: { sitemap_lastmod: e.lastmod ?? null },
  };
}

/** `"8008 Zürich, ZH"` → { postal_code, locality, canton }. Returns nulls for missing parts. */
export function parseGeo(geo: string | null): {
  postal_code: string | null;
  locality: string | null;
  canton: string | null;
} {
  if (!geo) return { postal_code: null, locality: null, canton: null };
  const m = geo.match(/^\s*(\d{4})\s+([^,]+?)\s*,\s*([A-Z]{2})\s*$/);
  if (!m) return { postal_code: null, locality: null, canton: null };
  return { postal_code: m[1] ?? null, locality: (m[2] ?? '').trim() || null, canton: m[3] ?? null };
}
