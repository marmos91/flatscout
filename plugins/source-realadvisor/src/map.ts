import type { RawListing } from '@wabe/core';
import type { RawHit } from './client.js';

/**
 * Map a realadvisor `RawHit` to Wabe's `RawListing`. Returns null when the hit
 * is unusable (e.g. missing id).
 *
 * The realadvisor clickout URL is an encrypted token resolved server-side, so
 * we point Wabe at the canonical realadvisor detail page derived from the
 * listing id instead of carrying the opaque clickout payload.
 */
export function mapHit(h: RawHit): RawListing | null {
  if (h.id === undefined || h.id === null || h.id === '') return null;
  const idStr = String(h.id);
  const url = `https://realadvisor.ch/en/listing/${idStr}`;
  const total = h.gross_rent_monthly ?? h.sale_price ?? null;
  return {
    id: `realadvisor:${idStr}`,
    source: 'source-realadvisor',
    url,
    price: {
      rent_net: h.rent_net_monthly ?? null,
      extras: h.rent_extra ?? null,
      total,
      currency: h.currency ?? 'CHF',
      deposit_months: null,
    },
    rooms: h.number_of_rooms ?? null,
    area_m2: h.living_surface ?? h.usable_surface ?? h.computed_surface ?? null,
    floor: null,
    total_floors: null,
    built_year: h.construction_year ?? null,
    renovated_year: h.renovation_year ?? null,
    location: {
      coords:
        h.lat !== null && h.lat !== undefined && h.lng !== null && h.lng !== undefined
          ? [h.lng, h.lat]
          : null,
      address: h.address ?? null,
      postal_code: h.postcode ?? null,
      city: h.locality ?? null,
      region: h.state ?? null,
      country: 'CH',
      neighborhood: h.sub_locality ?? null,
    },
    features: {},
    description: h.description ?? null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: h.agency_name ?? null,
    contact: {
      phone: h.agency_contact_phone_number ?? null,
    },
    enriched: {},
    extra: {
      realadvisor_hit_id: idStr,
      portal: h.portal ?? null,
    },
  };
}
