import { z } from 'zod';

export const SearchConfig = z
  .object({
    offer_type: z.enum(['rent', 'buy']).default('rent'),
    composite_property_type: z.enum(['apartment', 'house']).default('apartment'),
    /**
     * Place slugs (e.g. `canton-zurich`, `zurich`). Translated to the API's
     * `{ slug, lang }` object shape internally; callers configure plain strings.
     */
    place_slugs: z.array(z.string()).default(['canton-zurich']),
    /** Language used for place slug lookups (matches the slugs supplied above). */
    lang: z.enum(['en', 'fr', 'de', 'it']).default('en'),
    price_min: z.number().int().positive().nullable().default(null),
    price_max: z.number().int().positive().nullable().default(null),
    surface_min: z.number().int().positive().nullable().default(null),
    surface_max: z.number().int().positive().nullable().default(null),
    /**
     * Client-side PLZ allowlist. Empty array disables the filter. RealAdvisor
     * exposes no zipcode parameter — `place_slugs` is the coarsest server-side
     * knob — so this filter runs in the source plugin after the response
     * lands. Listings whose `postcode` is null are dropped when the
     * allowlist is non-empty (rare in practice; realadvisor populates it).
     */
    zipcodes: z.array(z.string().regex(/^\d{4}$/, 'PLZ must be a 4-digit Swiss postal code')).default([]),
  })
  .strict();
export type SearchConfig = z.infer<typeof SearchConfig>;

const PROPERTY_TYPE_CODE: Record<SearchConfig['composite_property_type'], string> = {
  apartment: 'APPT',
  house: 'HOUSE',
};

/** Build the query-string params for the realadvisor `/api/listings` endpoint. 1-based pagination. */
export function buildSearchParams(cfg: SearchConfig, page: number): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('offerType_eq', cfg.offer_type);
  sp.set('compositePropertyType_eq', PROPERTY_TYPE_CODE[cfg.composite_property_type]);
  // The realadvisor API expects an array of `{ slug, lang }` objects.
  const slugObjects = cfg.place_slugs.map((slug) => ({ slug, lang: cfg.lang }));
  sp.set('placeSlugs', JSON.stringify(slugObjects));
  if (cfg.price_min !== null) sp.set('priceMin_gte', String(cfg.price_min));
  if (cfg.price_max !== null) sp.set('priceMax_lte', String(cfg.price_max));
  if (cfg.surface_min !== null) sp.set('surfaceLivable_gte', String(cfg.surface_min));
  if (cfg.surface_max !== null) sp.set('surfaceLivable_lte', String(cfg.surface_max));
  sp.set('sort', 'created_at_desc');
  sp.set('page', String(page));
  return sp;
}
