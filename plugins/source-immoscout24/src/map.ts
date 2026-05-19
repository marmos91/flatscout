import type { RawListing } from '@wabe/core';
import type { DetailPayload, JsonLdListing } from './detail.js';
import type { SitemapEntry } from './sitemap.js';

/**
 * Sitemap entries yield URL-only listings with geo + thumbnail. When a
 * browser-bridge transport is available the caller re-fetches each PDP and
 * passes the parsed JSON-LD detail here so rooms/area/price/description get
 * filled in.
 */
export function mapEntry(e: SitemapEntry, detail: DetailPayload | null = null): RawListing | null {
  if (!e.loc) return null;
  // immoscout24 detail URL ends with /<id> — use last numeric segment as the id source.
  const idMatch = e.loc.match(/\/(\d+)(?:\?|$)/);
  const id = idMatch ? idMatch[1] : e.loc;
  const geo = parseGeo(e.geo_location);
  const d = detail?.listing ?? null;
  return {
    id: `immoscout24:${id}`,
    source: 'source-immoscout24-sitemap',
    url: e.loc,
    price: extractPrice(d),
    rooms: numericOrNull(d?.numberOfRooms),
    area_m2: numericOrNull(d?.floorSize?.value),
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: d?.address?.streetAddress ?? null,
      postal_code: d?.address?.postalCode ?? geo.postal_code,
      city: d?.address?.addressLocality ?? geo.locality,
      region: d?.address?.addressRegion ?? geo.canton,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: d?.description ?? null,
    photos: extractPhotos(d, e.image_loc ?? null),
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: { sitemap_lastmod: e.lastmod ?? null },
  };
}

function numericOrNull(v: number | string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function extractPrice(d: JsonLdListing | null): RawListing['price'] {
  const total = numericOrNull(d?.offers?.price);
  return {
    rent_net: null,
    extras: null,
    total,
    currency: (d?.offers?.priceCurrency ?? 'CHF') as RawListing['price']['currency'],
    deposit_months: null,
  };
}

function extractPhotos(d: JsonLdListing | null, fallback: string | null): string[] {
  if (d?.image) {
    if (Array.isArray(d.image)) return d.image.filter((x): x is string => typeof x === 'string');
    if (typeof d.image === 'string') return [d.image];
  }
  return fallback ? [fallback] : [];
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
