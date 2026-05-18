import { z } from 'zod';

/** User-facing Homegate search criteria. All fields server-side. */
export const SearchConfig = z.object({
  /** Swiss postcodes. Each is translated to a `geo-zipcode-NNNN` geoTag. */
  zipcodes: z.array(z.number().int().min(1000).max(9999)).default([]),
  price_max: z.number().int().positive().optional(),
  price_min: z.number().int().positive().optional(),
  rooms_min: z.number().positive().optional(),
  rooms_max: z.number().positive().optional(),
  surface_min: z.number().int().positive().optional(),
  property_type: z.enum(['APARTMENT_OR_HOUSE', 'APARTMENT', 'HOUSE']).default('APARTMENT_OR_HOUSE'),
  offer_type: z.literal('RENT').default('RENT'),
  has_balcony: z.boolean().optional(),
  has_elevator: z.boolean().optional(),
  sort_by: z.enum(['dateCreated', 'price', 'roomCount', 'livingSpace']).default('dateCreated'),
  sort_direction: z.enum(['asc', 'desc']).default('desc'),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

export interface SearchQuery {
  offerType: 'RENT';
  propertyType: 'APARTMENT_OR_HOUSE' | 'APARTMENT' | 'HOUSE';
  location?: { geoTags: string[] };
  monthlyRent?: { from?: number; to?: number };
  numberOfRooms?: { from?: number; to?: number };
  livingSpace?: { from?: number };
  hasBalcony?: boolean;
  hasElevator?: boolean;
}

export interface SearchBody {
  sortBy: string;
  sortDirection: string;
  trackTotalHits: true;
  from: number;
  size: number;
  fieldset: 'srp-list';
  query: SearchQuery;
}

/**
 * Translates the user-facing `SearchConfig` to the POST body shape captured
 * from the iOS Homegate app. Only emits fields the user actually set — e.g.
 * `monthlyRent.to` is omitted if `price_max` is undefined. `location` is
 * omitted entirely when no zipcodes are configured (the API treats absence as
 * "Switzerland-wide").
 */
export function buildSearchBody(cfg: SearchConfig, size: number, from: number): SearchBody {
  const query: SearchQuery = {
    offerType: cfg.offer_type,
    propertyType: cfg.property_type,
  };

  if (cfg.zipcodes.length > 0) {
    query.location = { geoTags: cfg.zipcodes.map((z) => `geo-zipcode-${z}`) };
  }

  if (cfg.price_max != null || cfg.price_min != null) {
    const monthlyRent: { from?: number; to?: number } = {};
    if (cfg.price_min != null) monthlyRent.from = cfg.price_min;
    if (cfg.price_max != null) monthlyRent.to = cfg.price_max;
    query.monthlyRent = monthlyRent;
  }

  if (cfg.rooms_min != null || cfg.rooms_max != null) {
    const numberOfRooms: { from?: number; to?: number } = {};
    if (cfg.rooms_min != null) numberOfRooms.from = cfg.rooms_min;
    if (cfg.rooms_max != null) numberOfRooms.to = cfg.rooms_max;
    query.numberOfRooms = numberOfRooms;
  }

  if (cfg.surface_min != null) {
    query.livingSpace = { from: cfg.surface_min };
  }

  if (cfg.has_balcony != null) query.hasBalcony = cfg.has_balcony;
  if (cfg.has_elevator != null) query.hasElevator = cfg.has_elevator;

  return {
    sortBy: cfg.sort_by,
    sortDirection: cfg.sort_direction,
    trackTotalHits: true,
    from,
    size,
    fieldset: 'srp-list',
    query,
  };
}
