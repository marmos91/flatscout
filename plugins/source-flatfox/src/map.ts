import { classifyRentalTerm, type RawListing } from '@wabe/core';

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
  /** Flatfox sub-category. Value `FURNISHED_FLAT` is the structured short-term signal. */
  object_type?: string | null;
  status?: string | null;
  published?: string | null;
  agency?: {
    name?: string | null;
    name_2?: string | null;
    street?: string | null;
    zipcode?: string | null;
    city?: string | null;
    country?: string | null;
    logo?: { url?: string | null } | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
  } | null;
  images?: Array<{ original_url?: string } | string> | null;
  /** Canonical relative path as returned by the API, e.g. `/en/flat/<slug>/<pk>/`. Preferred over pk-first variant since it avoids a 301 redirect. */
  url?: string | null;
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
  // Prefer API-canonical relative URL (slug-first, trailing slash) to avoid a 301 hop;
  // fall back to pk-only path when absent.
  const path = r.url?.startsWith('/') ? r.url : `/en/flat/${r.pk}/`;
  const url = `https://flatfox.ch${path}`;
  const rooms =
    typeof r.number_of_rooms === 'string'
      ? Number.parseFloat(r.number_of_rooms)
      : (r.number_of_rooms ?? null);
  const photos = Array.isArray(r.images)
    ? r.images
        .map((img) => (typeof img === 'string' ? img : (img.original_url ?? '')))
        .filter((u) => u.length > 0)
    : [];
  const description = r.description ?? r.public_title ?? r.short_title ?? null;
  const classified = classifyRentalTerm({
    description,
    is_furnished: r.object_type === 'FURNISHED_FLAT',
    lease_until: null,
    min_stay_days: null,
  });
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
      // GeoJSON order: [lng, lat] (matches Listing.location.coords convention).
      coords: r.latitude != null && r.longitude != null ? [r.longitude, r.latitude] : null,
      address: null,
      postal_code: r.zipcode != null ? String(r.zipcode) : null,
      city: r.city ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description,
    photos,
    available_from: r.moving_date ? new Date(r.moving_date) : null,
    lease_until: classified.lease_until,
    rental_term: classified.rental_term,
    agency: r.agency?.name ?? null,
    features: {},
    contact: buildContact(r.agency),
    enriched: buildEnriched(r.agency),
    extra: {},
  };
}

/** Canonical `{phone, email, form_url}` only — extra lister data goes to enriched. */
function buildContact(a: FlatfoxApiResult['agency']): Record<string, unknown> {
  if (!a) return {};
  const out: Record<string, unknown> = {};
  if (a.phone) out.phone = a.phone;
  if (a.email) out.email = a.email;
  return out;
}

/** Source-side richness, schema-safe. Mirrors `enriched.lister` key set used by source-homegate. */
function buildEnriched(a: FlatfoxApiResult['agency']): Record<string, unknown> {
  if (!a) return {};
  const lister: Record<string, unknown> = {};
  if (a.name) lister.legal_name = a.name;
  if (a.name_2) lister.legal_name_2 = a.name_2;
  if (a.logo?.url) {
    const url = a.logo.url;
    lister.logo_url = url.startsWith('http') ? url : `https://flatfox.ch${url}`;
  }
  if (a.website) lister.website = a.website;
  if (a.city || a.zipcode || a.street) {
    lister.address_locality = a.city ?? null;
  }
  return Object.keys(lister).length > 0 ? { lister } : {};
}
