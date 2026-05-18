import { z } from 'zod';

export const SearchConfig = z.object({
  location: z.object({
    lat: z.number(),
    lon: z.number(),
    radius_m: z.number().int().positive().default(1500),
  }),
  monthly_rent: z
    .object({
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .default({}),
  number_of_rooms: z.object({ from: z.number().optional(), to: z.number().optional() }).default({}),
  living_space: z
    .object({
      from: z.number().int().nonnegative().optional(),
      to: z.number().int().nonnegative().nullable().optional(),
    })
    .default({}),
  categories: z.array(z.string()).default(['APARTMENT']),
  offer_type: z.string().default('RENT'),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

export function buildBody(cfg: SearchConfig, page_size: number, offset: number): unknown {
  return {
    location: {
      latitude: cfg.location.lat,
      longitude: cfg.location.lon,
      radius: cfg.location.radius_m,
    },
    monthly_rent: cfg.monthly_rent,
    number_of_rooms: cfg.number_of_rooms,
    living_space: cfg.living_space,
    categories: cfg.categories,
    offer_type: cfg.offer_type,
    size: page_size,
    offset,
  };
}
