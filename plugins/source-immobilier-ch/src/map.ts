import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapDetail(url: string, payload: DetailPayload): RawListing | null {
  const { product, residence } = payload;
  // Need at least a Product to map.
  if (!product) return null;
  const idMatch = url.match(/-(\d+)(?:\?|$)/);
  const id = idMatch ? idMatch[1] : url;
  return {
    id: `immobilier-ch:${id}`,
    source: 'source-immobilier-ch',
    url,
    price: {
      rent_net: null,
      extras: null,
      total: toNum(product.offers?.price),
      currency: product.offers?.priceCurrency ?? 'CHF',
      deposit_months: null,
    },
    rooms: toNum(residence?.numberOfRooms),
    area_m2: toNum(residence?.floorSize?.value),
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: residence?.address?.streetAddress ?? null,
      postal_code: residence?.address?.postalCode ?? null,
      city: residence?.address?.addressLocality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: product.description ?? null,
    photos: Array.isArray(product.image) ? product.image : product.image ? [product.image] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
  };
}
