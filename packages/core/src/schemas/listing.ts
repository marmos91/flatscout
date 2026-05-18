import { z } from 'zod';

/**
 * Canonical normalised listing record passed between pipeline stages and
 * persisted as the JSON `payload` column.
 */
export const Listing = z.object({
  id: z.string(),
  source: z.string(),
  url: z.string().url(),
  first_seen_at: z.coerce.date(),
  last_seen_at: z.coerce.date(),
  price: z.object({
    rent_net: z.number().nullable(),
    extras: z.number().nullable(),
    total: z.number().nullable(),
    currency: z.string().default('CHF'),
    deposit_months: z.number().nullable(),
  }),
  rooms: z.number().nullable(),
  area_m2: z.number().nullable(),
  floor: z.number().nullable(),
  total_floors: z.number().nullable(),
  built_year: z.number().nullable(),
  renovated_year: z.number().nullable(),
  location: z.object({
    coords: z.tuple([z.number(), z.number()]).nullable(),
    address: z.string().nullable(),
    postal_code: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    country: z.string().default('CH'),
    neighborhood: z.string().nullable(),
  }),
  features: z.record(z.string(), z.unknown()).default({}),
  description: z.string().nullable(),
  photos: z.array(z.string().url()).default([]),
  available_from: z.coerce.date().nullable(),
  /** Earliest known end of the lease; `null` means "no end date detected" (not the same as "open-ended"). */
  lease_until: z.coerce.date().nullable().default(null),
  /** Rental term classification: explicit short-term/temporary, explicit long-term/permanent, or unknown. */
  rental_term: z.enum(['long', 'short', 'unknown']).default('unknown'),
  agency: z.string().nullable(),
  contact: z
    .object({
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      form_url: z.string().url().nullable().optional(),
    })
    .default({}),
  enriched: z.record(z.string(), z.unknown()).default({}),
  extra: z.record(z.string(), z.unknown()).default({}),
  /** sha256 of bucketed dedup fields (or URL when any bucket field is missing). Stamped by the pipeline at upsert time. */
  canonical_key: z.string().default(''),
  /** 0-100; higher wins on cross-source dedup tie. Stamped by the pipeline from `SOURCE_PRIORITY_DEFAULTS` unless overridden in config. */
  source_priority: z.number().int().min(0).max(100).default(50),
  // NOTE: deviated from plan — Task 2 listed only canonical_key + source_priority, but Task 4 constructs
  // `Listing` values with seen_on_sources, so the schema must include it. Empty default for tests.
  /** Sorted unique source names that have reported listings sharing this canonical_key. Materialised at upsert time. */
  seen_on_sources: z.array(z.string()).default([]),
});
export type Listing = z.infer<typeof Listing>;

/**
 * Listing shape emitted by source plugins before the orchestrator stamps
 * `id`/`first_seen_at`/`last_seen_at`. Sources MUST set `source` and `url`.
 */
export const RawListing = Listing.partial({
  id: true,
  first_seen_at: true,
  last_seen_at: true,
}).extend({
  source: z.string(),
  url: z.string().url(),
});
export type RawListing = z.infer<typeof RawListing>;
