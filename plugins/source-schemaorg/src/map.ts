import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapDetail(agencyId: string, url: string, payload: DetailPayload): RawListing | null {
  const l = payload.listing;
  if (!l) return null;
  const idMatch = url.match(/-(\d+)(?:\?|$)/) ?? url.match(/\/(\d+)(?:\?|\/?$)/);
  const idPart = idMatch ? idMatch[1] : url;
  return {
    id: `agency:${agencyId}:${idPart}`,
    source: `agency:schemaorg:${agencyId}`,
    url,
    price: {
      rent_net: null,
      extras: null,
      total: toNum(l.offers?.price),
      currency: l.offers?.priceCurrency ?? 'CHF',
      deposit_months: null,
    },
    rooms: toNum(l.numberOfRooms),
    area_m2: toNum(l.floorSize?.value),
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: l.address?.streetAddress ?? null,
      postal_code: l.address?.postalCode ?? null,
      city: l.address?.addressLocality ?? null,
      region: l.address?.addressRegion ?? null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: l.description ?? null,
    photos: Array.isArray(l.image) ? l.image : l.image ? [l.image] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: agencyId,
    contact: {},
    enriched: {},
    extra: {},
  };
}
