import type { Listing, RawListing } from './schemas/listing.js';

/**
 * Pure reducer: fold a new RawListing into an existing materialised Listing,
 * returning the next Listing and a flag indicating whether the merged payload
 * differs from `existing`. No DB access, no clock, no I/O.
 *
 * `incomingPriority` is the resolved source_priority for `raw` (already chosen
 * by the pipeline from config override or SOURCE_PRIORITY_DEFAULTS).
 *
 * Field rules per docs/superpowers/specs/2026-05-20-cross-source-row-collapse-design.md:
 *  - priority-wins per leaf with null-skip
 *  - photos: union dedup by URL equality, authoritative first then priority-desc
 *  - enriched: deep-merge per leaf; array leaves union-dedup
 *  - rental_term: 'unknown' always loses to 'long'/'short' regardless of priority
 *  - seen_on_sources: sorted union
 *  - first_seen_at: min; last_seen_at: max
 *  - id and canonical_key: constant (existing.id == existing.canonical_key)
 */
export function resolveFields(
  existing: Listing,
  raw: RawListing,
  incomingPriority: number,
): { next: Listing; changed: boolean } {
  const existingPriority = existing.source_priority;
  const existingIsAuthoritative =
    existingPriority > incomingPriority ||
    (existingPriority === incomingPriority && existing.first_seen_at <= (raw.first_seen_at ?? new Date()));

  const winner = existingIsAuthoritative ? existing : raw;
  const loser = existingIsAuthoritative ? raw : existing;

  const authoritativeSource = existingIsAuthoritative ? existing.source : raw.source;
  const authoritativeUrl = existingIsAuthoritative ? existing.url : raw.url;
  const authoritativePriority = existingIsAuthoritative ? existingPriority : incomingPriority;

  const next: Listing = {
    ...existing,
    source: authoritativeSource,
    url: authoritativeUrl,
    source_priority: authoritativePriority,
    first_seen_at: minDate(existing.first_seen_at, raw.first_seen_at),
    last_seen_at: maxDate(existing.last_seen_at, raw.last_seen_at),

    price: {
      currency: pickNonNull(winner.price?.currency, loser.price?.currency, existing.price.currency) ?? 'CHF',
      rent_net: pickNonNull(winner.price?.rent_net, loser.price?.rent_net) ?? null,
      extras: pickNonNull(winner.price?.extras, loser.price?.extras) ?? null,
      total: pickNonNull(winner.price?.total, loser.price?.total) ?? null,
      deposit_months: pickNonNull(winner.price?.deposit_months, loser.price?.deposit_months) ?? null,
    },

    rooms: pickNonNull(winner.rooms, loser.rooms) ?? null,
    area_m2: pickNonNull(winner.area_m2, loser.area_m2) ?? null,
    floor: pickNonNull(winner.floor, loser.floor) ?? null,
    total_floors: pickNonNull(winner.total_floors, loser.total_floors) ?? null,
    built_year: pickNonNull(winner.built_year, loser.built_year) ?? null,
    renovated_year: pickNonNull(winner.renovated_year, loser.renovated_year) ?? null,

    location: {
      coords: pickNonNull(winner.location?.coords, loser.location?.coords) ?? null,
      address: pickNonNull(winner.location?.address, loser.location?.address) ?? null,
      postal_code: pickNonNull(winner.location?.postal_code, loser.location?.postal_code) ?? null,
      city: pickNonNull(winner.location?.city, loser.location?.city) ?? null,
      region: pickNonNull(winner.location?.region, loser.location?.region) ?? null,
      country: pickNonNull(winner.location?.country, loser.location?.country) ?? 'CH',
      neighborhood: pickNonNull(winner.location?.neighborhood, loser.location?.neighborhood) ?? null,
    },

    description: pickNonNull(winner.description, loser.description) ?? null,
    agency: pickNonNull(winner.agency, loser.agency) ?? null,

    contact: {
      phone: pickNonNull(winner.contact?.phone, loser.contact?.phone) ?? null,
      email: pickNonNull(winner.contact?.email, loser.contact?.email) ?? null,
      form_url: pickNonNull(winner.contact?.form_url, loser.contact?.form_url) ?? null,
    },

    available_from: pickNonNull(winner.available_from, loser.available_from) ?? null,
    lease_until: pickNonNull(winner.lease_until, loser.lease_until) ?? null,

    rental_term: resolveRentalTerm(
      existing.rental_term,
      raw.rental_term ?? 'unknown',
      existingIsAuthoritative,
    ),

    features: { ...(loser.features ?? {}), ...(winner.features ?? {}) },
    extra: { ...(loser.extra ?? {}), ...(winner.extra ?? {}) },

    photos: unionPhotos(
      existingIsAuthoritative ? existing.photos : (raw.photos ?? []),
      existingIsAuthoritative ? (raw.photos ?? []) : existing.photos,
    ),

    enriched: deepMergeEnriched(existing.enriched, raw.enriched ?? {}, incomingPriority, existingPriority),

    seen_on_sources: sortedUnion(existing.seen_on_sources, [raw.source]),
  };

  const changed = canonicalize(stripVolatile(next)) !== canonicalize(stripVolatile(existing));
  return { next, changed };
}

/**
 * Stable JSON serialization that:
 *  - drops keys whose value is `null`/`undefined` (so `{phone: null}` ≡ `{}`),
 *  - sorts object keys,
 *  - leaves arrays in declared order (order matters for photos),
 *  - serializes Date as its ISO string.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(normalizeForCompare(value));
}

function normalizeForCompare(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      out[k] = normalizeForCompare(v);
    }
    return out;
  }
  return value;
}

function pickNonNull<T>(a: T | null | undefined, ...rest: Array<T | null | undefined>): T | null {
  if (a !== null && a !== undefined) return a;
  for (const v of rest) if (v !== null && v !== undefined) return v;
  return null;
}

function minDate(a: Date, b?: Date): Date {
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function maxDate(a: Date, b?: Date): Date {
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function sortedUnion(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort();
}

function unionPhotos(authoritative: string[], other: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...authoritative, ...other]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function resolveRentalTerm(
  existing: 'long' | 'short' | 'unknown',
  incoming: 'long' | 'short' | 'unknown',
  existingIsAuthoritative: boolean,
): 'long' | 'short' | 'unknown' {
  if (existing === 'unknown' && incoming !== 'unknown') return incoming;
  if (incoming === 'unknown' && existing !== 'unknown') return existing;
  return existingIsAuthoritative ? existing : incoming;
}

function deepMergeEnriched(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  incomingPriority: number,
  existingPriority: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in out)) {
      out[k] = v;
      continue;
    }
    const cur = out[k];
    if (Array.isArray(cur) && Array.isArray(v)) {
      out[k] = Array.from(new Set([...cur, ...v]));
      continue;
    }
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMergeEnriched(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
        incomingPriority,
        existingPriority,
      );
      continue;
    }
    if (incomingPriority > existingPriority) out[k] = v;
  }
  // Accumulate external_ids from both sides if present.
  const existingIds = (existing.external_ids ?? {}) as Record<string, string>;
  const incomingIds = (incoming.external_ids ?? {}) as Record<string, string>;
  const merged = { ...existingIds, ...incomingIds };
  if (Object.keys(merged).length > 0) {
    out.external_ids = merged;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
  );
}

function stripVolatile(l: Listing): Omit<Listing, 'last_seen_at'> {
  const { last_seen_at: _ignored, ...rest } = l;
  return rest;
}
