import type { RawListing } from '@wabe/core';

export interface HomegateListing {
  id: string;
  address?: {
    locality?: string | null;
    postal_code?: string | null;
    street?: string | null;
  };
  characteristics?: {
    number_of_rooms?: number | null;
    living_space?: number | null;
    floor?: number | null;
  };
  prices?: {
    rent?: { gross?: number | null; net?: number | null; extras?: number | null } | null;
  };
  description?: string | null;
  images?: Array<{ url?: string } | string> | null;
  realtor?: { name?: string | null } | null;
  coordinates?: { latitude?: number; longitude?: number } | null;
  link?: string;
}

export function mapHomegateListing(item: HomegateListing): RawListing {
  const photos = Array.isArray(item.images)
    ? item.images.map((i) => (typeof i === 'string' ? i : (i.url ?? ''))).filter((u) => u.length > 0)
    : [];
  const url = item.link ?? `https://www.homegate.ch/rent/${item.id}`;
  // NOTE: deviated from plan — same fix as source-flatfox. RawListing requires
  // features/contact/enriched/extra (they have Zod .default()s but remain
  // non-optional in the inferred TS type); explicitly include them.
  return {
    id: `homegate:${item.id}`,
    source: 'homegate',
    url,
    price: {
      rent_net: item.prices?.rent?.net ?? null,
      extras: item.prices?.rent?.extras ?? null,
      total: item.prices?.rent?.gross ?? null,
      currency: 'CHF',
      deposit_months: null,
    },
    rooms: item.characteristics?.number_of_rooms ?? null,
    area_m2: item.characteristics?.living_space ?? null,
    floor: item.characteristics?.floor ?? null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords:
        item.coordinates?.latitude != null && item.coordinates?.longitude != null
          ? [item.coordinates.latitude, item.coordinates.longitude]
          : null,
      address: item.address?.street ?? null,
      postal_code: item.address?.postal_code ?? null,
      city: item.address?.locality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description: item.description ?? null,
    photos,
    available_from: null,
    agency: item.realtor?.name ?? null,
    features: {},
    contact: {},
    enriched: {},
    extra: {},
  };
}
