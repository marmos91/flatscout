import type { RawListing } from '@wabe/core';
import type { RawHit } from './client.js';

/** Map a realadvisor `RawHit` to Wabe's `RawListing`. Returns null when the hit is unusable. */
export function mapHit(h: RawHit): RawListing | null {
  // realadvisor URLs are encrypted clickout tokens resolved server-side; use the canonical listing detail under realadvisor.ch as the URL field, with the id as the path.
  const url = h.url ?? `https://realadvisor.ch/en/listing/${h.id}`;
  return {
    id: `realadvisor:${h.id}`,
    source: 'source-realadvisor',
    url,
    price: {
      rent_net: null,
      extras: null,
      total: h.price?.value ?? null,
      currency: h.price?.currency ?? 'CHF',
      deposit_months: null,
    },
    rooms: h.rooms ?? null,
    area_m2: h.surface_livable ?? null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: h.postal_code ?? null,
      city: h.locality ?? null,
      region: h.canton ?? null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: { realadvisor_hit_id: h.id },
  };
}
