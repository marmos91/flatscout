import type { RawListing } from '@flatscout/core';
import type { ExtractedListing } from './extract.js';

export function mapDetail(
  agencyId: string,
  url: string,
  extracted: ExtractedListing | null,
): RawListing | null {
  if (!extracted) return null;
  const idMatch = url.match(/-(\d+)(?:\?|$)/) ?? url.match(/\/(\d+)(?:\?|\/?$)/);
  const idPart = idMatch ? idMatch[1] : url;
  const coords =
    extracted.geo.lat !== null && extracted.geo.lon !== null
      ? ([extracted.geo.lon, extracted.geo.lat] as [number, number])
      : null;
  return {
    id: `agency:${agencyId}:${idPart}`,
    source: `agency:schemaorg:${agencyId}`,
    url,
    price: {
      rent_net: null,
      extras: null,
      total: extracted.price_chf,
      currency: extracted.currency,
      deposit_months: null,
    },
    rooms: extracted.rooms,
    area_m2: extracted.area_m2,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords,
      address: extracted.address.street,
      postal_code: extracted.address.postal_code,
      city: extracted.address.city,
      region: extracted.address.region,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: extracted.description,
    photos: extracted.photos,
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: agencyId,
    contact: {},
    enriched: { extraction_tier: extracted.tier },
    extra: {},
  };
}
