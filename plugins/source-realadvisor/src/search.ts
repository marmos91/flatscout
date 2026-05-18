import { z } from 'zod';

export const SearchConfig = z
  .object({
    offer_type: z.enum(['rent', 'buy']).default('rent'),
    composite_property_type: z.enum(['apartment', 'house']).default('apartment'),
    place_slugs: z.array(z.string()).default(['canton-zurich']),
    price_min: z.number().int().positive().nullable().default(null),
    price_max: z.number().int().positive().nullable().default(null),
    surface_min: z.number().int().positive().nullable().default(null),
    surface_max: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type SearchConfig = z.infer<typeof SearchConfig>;

/** Build the query-string params for the realadvisor `/api/listings` endpoint. 1-based pagination. */
export function buildSearchParams(cfg: SearchConfig, page: number): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('offerType_eq', cfg.offer_type);
  sp.set('compositePropertyType_eq', cfg.composite_property_type);
  sp.set('placeSlugs', JSON.stringify(cfg.place_slugs));
  if (cfg.price_min !== null) sp.set('priceMin_gte', String(cfg.price_min));
  if (cfg.price_max !== null) sp.set('priceMax_lte', String(cfg.price_max));
  if (cfg.surface_min !== null) sp.set('surfaceLivable_gte', String(cfg.surface_min));
  if (cfg.surface_max !== null) sp.set('surfaceLivable_lte', String(cfg.surface_max));
  sp.set('sort', 'created_at_desc');
  sp.set('page', String(page));
  return sp;
}
