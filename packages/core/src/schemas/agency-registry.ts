import { z } from 'zod';

const CANTONS = [
  'ZH', 'BE', 'LU', 'UR', 'SZ', 'OW', 'NW', 'GL', 'ZG', 'FR', 'SO', 'BS', 'BL',
  'SH', 'AR', 'AI', 'SG', 'GR', 'AG', 'TG', 'TI', 'VD', 'VS', 'NE', 'GE', 'JU',
] as const;

export const AgencyEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case ([a-z0-9-]+)'),
  name: z.string().min(1),
  website: z.string().url(),
  canton: z.enum(CANTONS),
  platform: z.enum(['immomig', 'casasoft', 'schemaorg', 'custom']),
  feed_url: z.string().url().optional(),
  detail_url_template: z.string().optional(),
  rate_limit_per_min: z.number().int().positive().default(6),
  priority: z.number().int().min(0).max(100).default(100),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});
export type AgencyEntry = z.infer<typeof AgencyEntry>;

export const AgencyRegistry = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  fetched_at: z.string().datetime().optional(),
  agencies: z.array(AgencyEntry),
});
export type AgencyRegistry = z.infer<typeof AgencyRegistry>;
