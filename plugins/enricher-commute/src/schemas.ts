import { z } from 'zod';
import { CommuteMode } from '@wabe/core';

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const Target = z
  .object({
    address: z.string().min(1).optional(),
    coords: z.tuple([z.number(), z.number()]).optional(),
    arrive_by: HHMM,
    weekday: Weekday,
    modes: z.array(CommuteMode).min(1),
  })
  .refine((t) => !!t.address || !!t.coords, { message: 'target requires address or coords' });

export const CommuteConfig = z.object({
  endpoints: z.object({
    ors_url: z.string().url(),
    motis_url: z.string().url(),
    pelias_url: z.string().url(),
  }),
  targets: z.record(z.string(), Target).refine((m) => Object.keys(m).length > 0, {
    message: 'at least one target is required',
  }),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      quantize_decimals: z.number().int().min(0).max(6).default(4),
    })
    .default({ enabled: true, quantize_decimals: 4 }),
  timeouts: z
    .object({
      geocode_ms: z.number().int().positive().default(5000),
      route_ms: z.number().int().positive().default(15000),
    })
    .default({ geocode_ms: 5000, route_ms: 15000 }),
});
export type CommuteConfig = z.infer<typeof CommuteConfig>;

export const CommutePayload = z.record(
  z.string(),
  z.record(
    CommuteMode,
    z.object({
      duration_min: z.number().int().nonnegative(),
      distance_km: z.number().nonnegative(),
      computed_at: z.coerce.date(),
    }),
  ),
);
export type CommutePayload = z.infer<typeof CommutePayload>;
