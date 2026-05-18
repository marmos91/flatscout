import type { RawListing } from '@wabe/core';

export interface FlatfoxApiResult {
  pk: number;
  slug?: string;
  city?: string | null;
  zipcode?: number | null;
  price_display?: number | null;
  price_unit?: string | null;
  number_of_rooms?: string | number | null;
  surface_living?: number | null;
  public_title?: string | null;
  short_title?: string | null;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  moving_date_type?: string | null;
  moving_date?: string | null;
  offer_type?: string | null;
  object_category?: string | null;
  status?: string | null;
  published?: string | null;
  agency?: { name?: string | null } | null;
  images?: Array<{ original_url?: string } | string> | null;
}

/**
 * Maps a Flatfox API result into the canonical `RawListing` shape.
 *
 * Builds a stable `flatfox:${pk}` id, derives the canonical listing URL,
 * coerces the string-or-number `number_of_rooms` to a numeric value (or null),
 * and flattens the image list into URL strings. Fields not present in the
 * Flatfox response (floor, built year, contact, etc.) are set to null/empty.
 */
export function mapFlatfoxListing(r: FlatfoxApiResult): RawListing {
  const url = `https://flatfox.ch/en/flat/${r.pk}${r.slug ? `/${r.slug}` : ''}`;
  const rooms =
    typeof r.number_of_rooms === 'string'
      ? Number.parseFloat(r.number_of_rooms)
      : (r.number_of_rooms ?? null);
  const photos = Array.isArray(r.images)
    ? r.images
        .map((img) => (typeof img === 'string' ? img : (img.original_url ?? '')))
        .filter((u) => u.length > 0)
    : [];
  // NOTE: deviated from plan — RawListing requires features/contact/enriched/extra (defaulted but
  // non-optional in the inferred TS type); explicitly include them to satisfy strict typecheck.
  return {
    id: `flatfox:${r.pk}`,
    source: 'flatfox',
    url,
    price: {
      rent_net: null,
      extras: null,
      total: r.price_display ?? null,
      currency: 'CHF',
      deposit_months: null,
    },
    rooms: Number.isFinite(rooms as number) ? (rooms as number) : null,
    area_m2: r.surface_living ?? null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: r.latitude != null && r.longitude != null ? [r.latitude, r.longitude] : null,
      address: null,
      postal_code: r.zipcode != null ? String(r.zipcode) : null,
      city: r.city ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description: r.description ?? r.public_title ?? r.short_title ?? null,
    photos,
    available_from: r.moving_date ? new Date(r.moving_date) : null,
    agency: r.agency?.name ?? null,
    features: {},
    contact: {},
    enriched: {},
    extra: {},
  };
}
