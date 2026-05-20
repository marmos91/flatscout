# Cross-source row collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the per-(source, listing) row model into one fat row per logical listing keyed by `canonical_key`. Second-source observations enrich the existing row via a pure `resolveFields()` reducer; the notifier fires only on the FIRST canonical-row insert.

**Architecture:** New pure `resolveFields(existing, raw)` reducer in `@wabe/core/merge` (chosen over `@wabe/server/merge` to avoid the `@wabe/db ↔ @wabe/server` cycle the migration runner would otherwise need). `packages/server/src/dedupe.ts` is rewritten around it as `mergeUpsertCanonical(db, raw, ck) → UpsertResult`. `shouldNotify` becomes a pure function over `UpsertResult` (no DB lookup). Migration 0005 snapshots `listings` to `listings_legacy`, recreates `listings` with `canonical_key` as PK, then a TS runner in `@wabe/db` folds old rows through `resolveFields()` and rebuilds dependent-table FKs (`scores`, `notifications`, `failures.listing_id`) and `listings_fts`.

**Tech Stack:** TypeScript 5.6, Zod 3, better-sqlite3, vitest, pnpm workspaces, commander.

**Approved Spec:** `docs/superpowers/specs/2026-05-20-cross-source-row-collapse-design.md` — canonical design document.

---

## Decisions locked in this plan (resolving spec ambiguities)

| Question raised in spec | Decision |
|---|---|
| `resolveFields` location: `@wabe/server/merge` (devDep cycle) vs `@wabe/core` | **`@wabe/core/src/merge.ts`** — pure function over `Listing` + `RawListing` + `SOURCE_PRIORITY_DEFAULTS` (all already in core). No cycle. `@wabe/db` imports it directly. |
| Dependent-table FKs (`scores.listing_id`, `notifications.listing_id`, `failures.listing_id`) after collapse | Collapse runner builds a `Map<old_id, canonical_key>` and `UPDATE`s each dependent table to repoint FKs to the surviving row's id (= canonical_key). |
| `listings_fts` virtual table after collapse | The runner clears `listings_fts` and re-inserts one row per surviving `listings` row (`id`, `description`). |
| Enricher persistence after `isNew` upsert | New helper `writeListingPayload(db, listing)` overwrites the JSON payload (and last_seen_at) for a known canonical row. Used only by enricher stage. |
| MVP rollback strategy beyond `listings_legacy` | One CLI subcommand `wabe db rollback-collapse` per spec; refuses if migrations > 0005 are applied. |

---

## File Structure

```
packages/core/src/merge.ts                          # NEW: resolveFields() pure reducer
packages/core/src/index.ts                          # re-export resolveFields, UpsertMaterialised
packages/core/test/merge.test.ts                    # NEW: per-field resolution table tests

packages/server/src/dedupe.ts                       # rewrite: mergeUpsertCanonical + writeListingPayload
packages/server/src/canonical-dedup.ts              # simplify: shouldNotify(UpsertResult, Listing)
packages/server/src/pipeline.ts                     # call merge once, read merged row, enrich only on isNew
packages/server/test/dedupe.test.ts                 # rewrite around mergeUpsertCanonical
packages/server/test/canonical-dedup.test.ts        # simplify (no DB)
packages/server/test/pipeline-dedup.integration.test.ts  # update: notify-once across sources

packages/db/migrations/0005_collapse_canonical.sql  # NEW: snapshot + recreate listings
packages/db/src/collapse-listings.ts                # NEW: TS migration runner
packages/db/src/migrate.ts                          # invoke collapse runner after 0005 applies
packages/db/package.json                            # depend on @wabe/core (already present — verify)
packages/db/test/collapse-listings.test.ts          # NEW: runner unit/integration

packages/cli/src/commands/db.ts                     # NEW: wabe db rollback-collapse
packages/cli/src/index.ts                           # register the db subcommand

packages/core/src/schemas/listing.ts                # doc-only: clarify post-collapse semantics
README.md                                           # document the canonical-row model
CLAUDE.md                                           # "Architecture summary" reflects new model
```

---

## Task 0: Schema migration SQL (0005)

**Files:**
- Create: `packages/db/migrations/0005_collapse_canonical.sql`

- [ ] **Step 1: Write the migration SQL**

`packages/db/migrations/0005_collapse_canonical.sql`:

```sql
-- Cross-source row collapse: one row per canonical_key.
-- The TS runner in @wabe/db/src/collapse-listings.ts is invoked by migrate.ts
-- inside the same transaction window after this SQL applies. It folds rows from
-- listings_old into the new listings table via resolveFields().

-- Snapshot pre-collapse rows so a rollback works without re-fetching.
CREATE TABLE listings_legacy AS SELECT * FROM listings;

-- Rename current listings out of the way. The TS runner reads from it.
ALTER TABLE listings RENAME TO listings_old;

-- Recreate listings with canonical_key as PK. Column shape unchanged; id == canonical_key.
CREATE TABLE listings (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  payload         TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',
  blocked_reason  TEXT,
  canonical_key   TEXT NOT NULL,
  source_priority INTEGER NOT NULL DEFAULT 50,
  seen_on_sources TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_listings_canonical_key ON listings (canonical_key);
CREATE INDEX idx_listings_source ON listings (source);
CREATE INDEX idx_listings_first_seen ON listings (first_seen_at);

-- listings_fts is repopulated by the TS runner; clear it here.
DELETE FROM listings_fts;
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/migrations/0005_collapse_canonical.sql
git commit -m "db(0005): snapshot listings_legacy + recreate listings with canonical_key PK"
```

---

## Task 1: `resolveFields()` pure reducer in `@wabe/core`

**Files:**
- Create: `packages/core/src/merge.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/merge.test.ts`

The reducer takes an existing materialised `Listing` and a new `RawListing` (plus the new arrival's resolved priority) and returns the next `Listing` + a `changed` flag. Pure, no DB.

- [ ] **Step 1: Write the failing test — null-skip + priority-wins on a single scalar**

`packages/core/test/merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveFields } from '../src/merge.js';
import { Listing, type RawListing } from '../src/schemas/listing.js';

function baseExisting(overrides: Partial<unknown> = {}): Listing {
  return Listing.parse({
    id: 'ck-abc',
    source: 'source-flatfox',
    source_priority: 80,
    url: 'https://flatfox.ch/1',
    canonical_key: 'ck-abc',
    seen_on_sources: ['source-flatfox'],
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {}, description: null, photos: [], available_from: null, lease_until: null,
    rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    ...overrides,
  });
}

describe('resolveFields — priority-wins + null-skip', () => {
  it('lower-priority source fills null fields without overwriting non-null ones', () => {
    const existing = baseExisting({ description: 'flatfox copy' });
    const raw: RawListing = {
      source: 'source-realadvisor',
      url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: 2800, extras: 400, total: 3200, currency: 'CHF', deposit_months: 2 },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: 'Seefeldstrasse 1', postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: 'different copy', photos: [], available_from: null, lease_until: null,
      rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    };

    const { next, changed } = resolveFields(existing, raw, 50);

    expect(next.source).toBe('source-flatfox');           // authoritative unchanged (80 > 50)
    expect(next.url).toBe('https://flatfox.ch/1');
    expect(next.source_priority).toBe(80);
    expect(next.description).toBe('flatfox copy');         // priority-wins, non-null kept
    expect(next.price.rent_net).toBe(2800);                // null-skip — lower priority fills
    expect(next.price.extras).toBe(400);
    expect(next.price.deposit_months).toBe(2);
    expect(next.location.address).toBe('Seefeldstrasse 1');// null-skip
    expect(next.seen_on_sources).toEqual(['source-flatfox', 'source-realadvisor']);
    expect(changed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/core test merge.test`
Expected: FAIL — `resolveFields` is not defined / module not found.

- [ ] **Step 3: Write the `resolveFields` skeleton**

`packages/core/src/merge.ts`:

```ts
import { Listing, RawListing } from './schemas/listing.js';

/**
 * Pure reducer: fold a new RawListing into an existing materialised Listing,
 * returning the next Listing and a flag indicating whether the merged payload
 * differs from `existing`. No DB access, no clock, no I/O.
 *
 * `incomingPriority` is the resolved source_priority for `raw` (already chosen
 * by the pipeline from config override or SOURCE_PRIORITY_DEFAULTS).
 *
 * Field rules per spec (docs/superpowers/specs/2026-05-20-cross-source-row-collapse-design.md):
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

  // Pick the "winner" record for priority-wins decisions.
  const winner = existingIsAuthoritative ? existing : raw;
  const loser = existingIsAuthoritative ? raw : existing;

  // Authoritative scalars (source, url, source_priority) follow the winner.
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

    rental_term: resolveRentalTerm(existing.rental_term, raw.rental_term ?? 'unknown', existingIsAuthoritative),

    features: { ...(loser.features ?? {}), ...(winner.features ?? {}) },
    extra: { ...(loser.extra ?? {}), ...(winner.extra ?? {}) },

    photos: unionPhotos(
      existingIsAuthoritative ? existing.photos : raw.photos ?? [],
      existingIsAuthoritative ? raw.photos ?? [] : existing.photos,
    ),

    enriched: deepMergeEnriched(existing.enriched, raw.enriched ?? {}, incomingPriority, existingPriority, raw.source),

    seen_on_sources: sortedUnion(existing.seen_on_sources, [raw.source]),
  };

  const changed = JSON.stringify(stripVolatile(next)) !== JSON.stringify(stripVolatile(existing));
  return { next, changed };
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
  // 'unknown' always loses to a non-'unknown' value, regardless of priority.
  if (existing === 'unknown' && incoming !== 'unknown') return incoming;
  if (incoming === 'unknown' && existing !== 'unknown') return existing;
  return existingIsAuthoritative ? existing : incoming;
}

function deepMergeEnriched(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  incomingPriority: number,
  existingPriority: number,
  incomingSource: string,
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
        incomingSource,
      );
      continue;
    }
    // Scalar conflict — priority-wins.
    if (incomingPriority > existingPriority) out[k] = v;
  }
  // Accumulate external_ids: { [source]: raw.id }.
  const ids = (out.external_ids ?? {}) as Record<string, string>;
  // The runner / pipeline that produced `raw` is responsible for passing raw.id via incoming.external_ids.
  out.external_ids = { ...ids, ...(incoming.external_ids as Record<string, string> | undefined ?? {}) };
  if (Object.keys(out.external_ids as object).length === 0) delete out.external_ids;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// last_seen_at is volatile and must NOT trigger `changed`.
function stripVolatile(l: Listing): Omit<Listing, 'last_seen_at'> {
  const { last_seen_at: _, ...rest } = l;
  return rest;
}
```

- [ ] **Step 4: Re-export from `@wabe/core`**

Edit `packages/core/src/index.ts`, add:

```ts
export { resolveFields } from './merge.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wabe/core test merge.test`
Expected: PASS.

- [ ] **Step 6: Add the remaining per-field tests (one by one, TDD)**

Append to `packages/core/test/merge.test.ts`:

```ts
describe('resolveFields — authoritative switch on higher priority', () => {
  it('higher-priority incoming flips source/url/priority; existing non-null fields kept where incoming has nulls', () => {
    const existing = baseExisting({
      source: 'source-realadvisor', source_priority: 50,
      url: 'https://realadvisor.ch/2',
      description: 'realadvisor copy',
      contact: { phone: '+41 44 000 00 00', email: null, form_url: null },
      seen_on_sources: ['source-realadvisor'],
    });
    const raw: RawListing = {
      source: 'source-flatfox',
      url: 'https://flatfox.ch/1',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null, photos: [], available_from: null, lease_until: null,
      rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    };
    const { next } = resolveFields(existing, raw, 80);
    expect(next.source).toBe('source-flatfox');
    expect(next.url).toBe('https://flatfox.ch/1');
    expect(next.source_priority).toBe(80);
    expect(next.description).toBe('realadvisor copy');         // null-skip preserves loser value
    expect(next.contact.phone).toBe('+41 44 000 00 00');
  });
});

describe('resolveFields — ties broken by first_seen_at (older wins)', () => {
  it('same priority: older first_seen_at remains authoritative', () => {
    const existing = baseExisting({
      source: 'source-homegate', source_priority: 70, url: 'https://homegate.ch/1',
      first_seen_at: new Date('2026-05-18T10:00:00Z'),
    });
    const raw: RawListing = {
      source: 'source-immoscout24', url: 'https://immoscout24.ch/9',
      first_seen_at: new Date('2026-05-19T10:00:00Z'),
      last_seen_at: new Date('2026-05-19T10:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null, photos: [], available_from: null, lease_until: null,
      rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    };
    const { next } = resolveFields(existing, raw, 70);
    expect(next.source).toBe('source-homegate');
    expect(next.url).toBe('https://homegate.ch/1');
  });
});

describe('resolveFields — photos union', () => {
  it('authoritative photos first, then other-source photos, dedup by URL', () => {
    const existing = baseExisting({
      source: 'source-flatfox', source_priority: 80,
      photos: ['https://cdn.flatfox.ch/a.jpg', 'https://cdn.flatfox.ch/b.jpg'],
    });
    const raw: RawListing = {
      source: 'source-realadvisor', url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null,
      photos: ['https://cdn.flatfox.ch/a.jpg', 'https://cdn.ra.ch/x.jpg'],
      available_from: null, lease_until: null, rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.photos).toEqual([
      'https://cdn.flatfox.ch/a.jpg',
      'https://cdn.flatfox.ch/b.jpg',
      'https://cdn.ra.ch/x.jpg',
    ]);
  });
});

describe('resolveFields — rental_term', () => {
  it("'unknown' loses to 'long' regardless of priority", () => {
    const existing = baseExisting({ source: 'source-flatfox', source_priority: 80, rental_term: 'unknown' });
    const raw: RawListing = {
      source: 'source-realadvisor', url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null, photos: [], available_from: null, lease_until: null,
      rental_term: 'long', agency: null, contact: {}, enriched: {}, extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.rental_term).toBe('long');
  });
});

describe('resolveFields — enriched deep-merge + external_ids', () => {
  it('merges enriched maps with array union and external_ids accumulation', () => {
    const existing = baseExisting({
      source: 'source-flatfox', source_priority: 80,
      enriched: {
        commute: { home: { duration_s: 1800 } },
        amenities: ['lift'],
        external_ids: { 'source-flatfox': 'ff-1' },
      },
    });
    const raw: RawListing = {
      source: 'source-realadvisor', url: 'https://realadvisor.ch/2',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null, photos: [], available_from: null, lease_until: null,
      rental_term: 'unknown', agency: null, contact: {},
      enriched: {
        amenities: ['lift', 'balcony'],
        commute: { office: { duration_s: 600 } },
        external_ids: { 'source-realadvisor': 'ra-2' },
      },
      extra: {},
    };
    const { next } = resolveFields(existing, raw, 50);
    expect(next.enriched.amenities).toEqual(expect.arrayContaining(['lift', 'balcony']));
    expect((next.enriched.commute as Record<string, unknown>).home).toEqual({ duration_s: 1800 });
    expect((next.enriched.commute as Record<string, unknown>).office).toEqual({ duration_s: 600 });
    expect(next.enriched.external_ids).toEqual({ 'source-flatfox': 'ff-1', 'source-realadvisor': 'ra-2' });
  });
});

describe('resolveFields — seen_on_sources', () => {
  it('produces a sorted union including the incoming source', () => {
    const existing = baseExisting({ seen_on_sources: ['source-flatfox', 'source-realadvisor'] });
    const raw: RawListing = {
      source: 'source-homegate', url: 'https://homegate.ch/1',
      first_seen_at: new Date('2026-05-19T09:00:00Z'),
      last_seen_at: new Date('2026-05-19T09:00:00Z'),
      price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
      rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
      location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      features: {}, description: null, photos: [], available_from: null, lease_until: null,
      rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    };
    const { next } = resolveFields(existing, raw, 70);
    expect(next.seen_on_sources).toEqual(['source-flatfox', 'source-homegate', 'source-realadvisor']);
  });
});

describe('resolveFields — conservative changed flag', () => {
  it('returns changed=false when payload (excluding last_seen_at) is identical', () => {
    const existing = baseExisting();
    const raw: RawListing = {
      source: existing.source, url: existing.url,
      first_seen_at: existing.first_seen_at,
      last_seen_at: new Date(existing.last_seen_at.getTime() + 60_000),
      price: existing.price,
      rooms: existing.rooms, area_m2: existing.area_m2,
      floor: existing.floor, total_floors: existing.total_floors,
      built_year: existing.built_year, renovated_year: existing.renovated_year,
      location: existing.location,
      features: existing.features, description: existing.description,
      photos: existing.photos, available_from: existing.available_from,
      lease_until: existing.lease_until, rental_term: existing.rental_term,
      agency: existing.agency, contact: existing.contact,
      enriched: existing.enriched, extra: existing.extra,
    };
    const { changed } = resolveFields(existing, raw, existing.source_priority);
    expect(changed).toBe(false);
  });
});
```

- [ ] **Step 7: Run all merge tests**

Run: `pnpm --filter @wabe/core test merge.test`
Expected: PASS (all suites).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/merge.ts packages/core/src/index.ts packages/core/test/merge.test.ts
git commit -m "core(merge): resolveFields pure reducer + table-driven tests"
```

---

## Task 2: `mergeUpsertCanonical` + `writeListingPayload` rewrite

**Files:**
- Modify: `packages/server/src/dedupe.ts` (rewrite)
- Test: `packages/server/test/dedupe.test.ts` (rewrite)

Replaces `upsertListing(db, listing)` with `mergeUpsertCanonical(db, raw, ck) → UpsertResult` and adds `writeListingPayload(db, listing)` for enricher persistence.

- [ ] **Step 1: Write the failing test — first arrival INSERT**

`packages/server/test/dedupe.test.ts` (rewrite from scratch):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type WabeDb } from '@wabe/db';
import { canonicalKey } from '@wabe/core';
import type { RawListing } from '@wabe/core';
import { mergeUpsertCanonical, readListing, writeListingPayload } from '../src/dedupe.js';

let dir: string;
function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-dedup-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return db;
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function raw(overrides: Partial<RawListing> & Pick<RawListing, 'source' | 'url'>): RawListing {
  return {
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {}, description: null, photos: [], available_from: null, lease_until: null,
    rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    ...overrides,
  };
}

function ck(r: RawListing): string {
  return canonicalKey({
    postal_code: r.location?.postal_code ?? null,
    rooms: r.rooms ?? null,
    area_m2: r.area_m2 ?? null,
    price_total: r.price?.total ?? null,
    url: r.url,
  });
}

describe('mergeUpsertCanonical — first arrival', () => {
  it('inserts a fresh row with id = canonical_key and seen_on_sources = [source]', () => {
    const db = freshDb();
    const r = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(r);

    const res = mergeUpsertCanonical(db, r, k, 80);

    expect(res.isNew).toBe(true);
    expect(res.changed).toBe(true);
    const merged = readListing(db, k);
    expect(merged?.id).toBe(k);
    expect(merged?.source).toBe('source-flatfox');
    expect(merged?.source_priority).toBe(80);
    expect(merged?.seen_on_sources).toEqual(['source-flatfox']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/server test dedupe.test`
Expected: FAIL — `mergeUpsertCanonical` not exported.

- [ ] **Step 3: Rewrite `packages/server/src/dedupe.ts`**

```ts
import { Listing, type RawListing, resolveFields } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
}

/**
 * Upserts a RawListing into the collapsed `listings` table where `id == canonical_key`.
 *
 * - No row at ck: materialise a fresh Listing from `raw` (id=ck), INSERT, return isNew=true.
 * - Row exists: fold `raw` through `resolveFields` against the existing payload.
 *   UPDATE only if `changed`. `isNew` is always false on an existing row.
 *
 * Returns `{ isNew, changed, fingerprint }`. `fingerprint` mirrors the new row's id
 * for downstream logging compatibility.
 */
export function mergeUpsertCanonical(
  db: WabeDb,
  raw: RawListing,
  ck: string,
  incomingPriority: number,
): UpsertResult {
  const now = Date.now();
  const existing = db._raw
    .prepare<[string], { payload: string }>('SELECT payload FROM listings WHERE id = ?')
    .get(ck);

  if (!existing) {
    const next = materialise(raw, ck, incomingPriority);
    insertRow(db, next, now);
    insertFts(db, next);
    return { changed: true, isNew: true, fingerprint: ck };
  }

  const existingListing = Listing.parse(JSON.parse(existing.payload));
  const { next, changed } = resolveFields(existingListing, raw, incomingPriority);

  if (!changed) {
    db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, ck);
    return { changed: false, isNew: false, fingerprint: ck };
  }

  updateRow(db, next, now);
  updateFts(db, next);
  return { changed: true, isNew: false, fingerprint: ck };
}

/** Overwrite a known canonical row's payload — used by the enricher stage. */
export function writeListingPayload(db: WabeDb, listing: Listing): void {
  const now = Date.now();
  updateRow(db, listing, now);
  updateFts(db, listing);
}

/** Read the materialised canonical row by canonical_key (= id). */
export function readListing(db: WabeDb, ck: string): Listing | null {
  const row = db._raw
    .prepare<[string], { payload: string }>('SELECT payload FROM listings WHERE id = ?')
    .get(ck);
  return row ? Listing.parse(JSON.parse(row.payload)) : null;
}

function materialise(raw: RawListing, ck: string, priority: number): Listing {
  return Listing.parse({
    ...raw,
    id: ck,
    canonical_key: ck,
    source_priority: priority,
    first_seen_at: raw.first_seen_at ?? new Date(),
    last_seen_at: raw.last_seen_at ?? new Date(),
    seen_on_sources: [raw.source],
    enriched: {
      ...(raw.enriched ?? {}),
      external_ids: {
        ...((raw.enriched as Record<string, unknown> | undefined)?.external_ids as Record<string, string> | undefined ?? {}),
        ...(raw.id ? { [raw.source]: raw.id } : {}),
      },
    },
  });
}

function insertRow(db: WabeDb, l: Listing, now: number): void {
  db._raw
    .prepare(
      'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      l.id, l.source, l.url, l.id, JSON.stringify(l),
      l.first_seen_at.getTime(), now, 'new',
      l.canonical_key, l.source_priority, JSON.stringify(l.seen_on_sources),
    );
}

function updateRow(db: WabeDb, l: Listing, now: number): void {
  db._raw
    .prepare(
      'UPDATE listings SET source=?, url=?, payload=?, last_seen_at=?, source_priority=?, seen_on_sources=? WHERE id=?',
    )
    .run(l.source, l.url, JSON.stringify(l), now, l.source_priority, JSON.stringify(l.seen_on_sources), l.id);
}

function insertFts(db: WabeDb, l: Listing): void {
  db._raw
    .prepare('INSERT INTO listings_fts (id, description) VALUES (?, ?)')
    .run(l.id, l.description ?? '');
}

function updateFts(db: WabeDb, l: Listing): void {
  db._raw.prepare('DELETE FROM listings_fts WHERE id = ?').run(l.id);
  insertFts(db, l);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wabe/server test dedupe.test`
Expected: PASS.

- [ ] **Step 5: Add the remaining merge-path tests**

Append to `packages/server/test/dedupe.test.ts`:

```ts
describe('mergeUpsertCanonical — second source merge', () => {
  it('lower-priority second source fills null fields, unions photos, isNew=false', () => {
    const db = freshDb();
    const ff = raw({
      source: 'source-flatfox', url: 'https://flatfox.ch/1',
      description: 'flatfox copy',
      photos: ['https://flatfox.ch/a.jpg'],
    });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);

    const ra = raw({
      source: 'source-realadvisor', url: 'https://realadvisor.ch/2',
      contact: { phone: '+41 44 000 00 00' },
      photos: ['https://ra.ch/x.jpg'],
      description: null,
    });
    const res = mergeUpsertCanonical(db, ra, k, 50);

    expect(res.isNew).toBe(false);
    expect(res.changed).toBe(true);
    const merged = readListing(db, k);
    expect(merged?.source).toBe('source-flatfox');               // authoritative unchanged
    expect(merged?.contact.phone).toBe('+41 44 000 00 00');      // null-skip wins
    expect(merged?.photos).toEqual(['https://flatfox.ch/a.jpg', 'https://ra.ch/x.jpg']);
    expect(merged?.seen_on_sources).toEqual(['source-flatfox', 'source-realadvisor']);
  });

  it('higher-priority second source flips authoritative source/url/priority', () => {
    const db = freshDb();
    const ra = raw({ source: 'source-realadvisor', url: 'https://realadvisor.ch/2' });
    const k = ck(ra);
    mergeUpsertCanonical(db, ra, k, 50);

    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    mergeUpsertCanonical(db, ff, k, 80);

    const merged = readListing(db, k);
    expect(merged?.source).toBe('source-flatfox');
    expect(merged?.url).toBe('https://flatfox.ch/1');
    expect(merged?.source_priority).toBe(80);
  });

  it('same payload from same source is a no-op (changed=false, isNew=false)', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const res = mergeUpsertCanonical(db, ff, k, 80);
    expect(res).toEqual({ isNew: false, changed: false, fingerprint: k });
  });

  it('external_ids accumulate across sources', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1', id: 'flatfox:ff-1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const ra = raw({ source: 'source-realadvisor', url: 'https://realadvisor.ch/2', id: 'realadvisor:ra-2' });
    mergeUpsertCanonical(db, ra, k, 50);

    const merged = readListing(db, k);
    expect(merged?.enriched.external_ids).toEqual({
      'source-flatfox': 'flatfox:ff-1',
      'source-realadvisor': 'realadvisor:ra-2',
    });
  });
});

describe('writeListingPayload — enricher persistence', () => {
  it('overwrites payload + last_seen_at without altering seen_on_sources', () => {
    const db = freshDb();
    const ff = raw({ source: 'source-flatfox', url: 'https://flatfox.ch/1' });
    const k = ck(ff);
    mergeUpsertCanonical(db, ff, k, 80);
    const merged = readListing(db, k)!;
    merged.enriched = { ...merged.enriched, commute: { home: { duration_s: 900 } } };
    writeListingPayload(db, merged);

    const after = readListing(db, k);
    expect((after?.enriched.commute as Record<string, unknown>).home).toEqual({ duration_s: 900 });
    expect(after?.seen_on_sources).toEqual(['source-flatfox']);
  });
});
```

- [ ] **Step 6: Run full dedupe suite**

Run: `pnpm --filter @wabe/server test dedupe.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/dedupe.ts packages/server/test/dedupe.test.ts
git commit -m "server(dedupe): mergeUpsertCanonical + writeListingPayload around resolveFields"
```

---

## Task 3: Simplify `shouldNotify`

**Files:**
- Modify: `packages/server/src/canonical-dedup.ts`
- Modify: `packages/server/test/canonical-dedup.test.ts`

- [ ] **Step 1: Rewrite the test (no DB, pure-function inputs)**

Replace `packages/server/test/canonical-dedup.test.ts` content:

```ts
import { describe, expect, it } from 'vitest';
import { Listing } from '@wabe/core';
import { shouldNotify } from '../src/canonical-dedup.js';
import type { UpsertResult } from '../src/dedupe.js';

function listing(seen: string[], source: string): Listing {
  return Listing.parse({
    id: 'ck-abc', source, source_priority: 80,
    url: 'https://example.ch/1', canonical_key: 'ck-abc',
    seen_on_sources: seen,
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {}, description: null, photos: [], available_from: null, lease_until: null,
    rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
  });
}

const isNew: UpsertResult = { changed: true, isNew: true, fingerprint: 'ck-abc' };
const existing: UpsertResult = { changed: true, isNew: false, fingerprint: 'ck-abc' };

describe('shouldNotify', () => {
  it('fires once on isNew=true (suppress=false, also_seen_on=[])', () => {
    const v = shouldNotify(isNew, listing(['source-flatfox'], 'source-flatfox'));
    expect(v).toEqual({ suppress: false, also_seen_on: [] });
  });

  it('suppresses on isNew=false and reports other sources', () => {
    const v = shouldNotify(existing, listing(['source-flatfox', 'source-realadvisor'], 'source-flatfox'));
    expect(v.suppress).toBe(true);
    expect(v.also_seen_on).toEqual(['source-realadvisor']);
  });

  it('strips authoritative source from also_seen_on', () => {
    const v = shouldNotify(existing, listing(['source-flatfox', 'source-homegate'], 'source-flatfox'));
    expect(v.also_seen_on).toEqual(['source-homegate']);
  });
});
```

- [ ] **Step 2: Rewrite `packages/server/src/canonical-dedup.ts`**

```ts
import type { Listing } from '@wabe/core';
import type { UpsertResult } from './dedupe.js';

export interface DedupVerdict {
  /** True when the canonical row already existed before this scan (notify must NOT fire). */
  suppress: boolean;
  /** Other sources that have contributed to this canonical row (for the "Also on:" footer). */
  also_seen_on: string[];
}

/**
 * Notify-time cross-source dedup verdict. Pure function — derives from the
 * upsert outcome and the merged listing's `seen_on_sources` / authoritative
 * source. Notification fires once per canonical row, on its first INSERT.
 */
export function shouldNotify(upsertResult: UpsertResult, listing: Listing): DedupVerdict {
  if (upsertResult.isNew) {
    return { suppress: false, also_seen_on: [] };
  }
  return {
    suppress: true,
    also_seen_on: listing.seen_on_sources.filter((s) => s !== listing.source).sort(),
  };
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @wabe/server test canonical-dedup.test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/canonical-dedup.ts packages/server/test/canonical-dedup.test.ts
git commit -m "server(canonical-dedup): shouldNotify becomes a pure fn over UpsertResult"
```

---

## Task 4: Pipeline rewrite — merge once, enrich only on isNew

**Files:**
- Modify: `packages/server/src/pipeline.ts`

- [ ] **Step 1: Replace the per-listing block in `runSource`**

Open `packages/server/src/pipeline.ts`. Replace the imports and the `for await` body inside `runSource`:

Imports (line 15–16) change to:

```ts
import { mergeUpsertCanonical, readListing, writeListingPayload } from './dedupe.js';
import { shouldNotify } from './canonical-dedup.js';
```

Replace the block starting `for await (const raw of src.plugin.fetch(ctx)) {` through to the `log.info(...)` end-of-iteration line with:

```ts
for await (const raw of src.plugin.fetch(ctx)) {
  if (opts.signal.aborted) return;

  const ck = canonicalKey({
    postal_code: raw.location?.postal_code ?? null,
    rooms: raw.rooms ?? null,
    area_m2: raw.area_m2 ?? null,
    price_total: raw.price?.total ?? null,
    url: raw.url,
  });

  // Resolve incoming source priority — explicit config wins over registry defaults.
  const cfgPriority = (src.config as { priority?: unknown } | undefined)?.priority;
  const priority =
    typeof cfgPriority === 'number'
      ? cfgPriority
      : (SOURCE_PRIORITY_DEFAULTS[src.plugin.name] ?? DEFAULT_SOURCE_PRIORITY);

  const upsertResult = mergeUpsertCanonical(opts.db, raw, ck, priority);
  if (!upsertResult.changed && !upsertResult.isNew) continue;

  // Read the materialised row so downstream stages see the merged Listing.
  let current = readListing(opts.db, ck);
  if (!current) {
    log.warn({ canonical_key: ck }, 'merged row missing immediately after upsert; skipping');
    continue;
  }

  // Enricher stage runs only on first arrival, per spec.
  if (upsertResult.isNew) {
    for (const e of opts.enrichers) {
      try {
        const before = JSON.stringify(current.enriched);
        current = await e.plugin.enrich(current, {
          logger: log.child({ enricher: e.plugin.name }),
          config: e.config,
          signal: opts.signal,
          db: opts.db,
        });
        if (JSON.stringify(current.enriched) !== before) {
          writeListingPayload(opts.db, current);
        }
      } catch (err) {
        log.warn({ err, enricher: e.plugin.name, listing_id: current.id }, 'enricher failed; continuing');
      }
    }
  }

  const termVerdict = rentalTermPasses(current, opts.cfg.rentalTerm);
  if (!termVerdict.ok) {
    log.debug({ listing_id: current.id, reason: termVerdict.reason }, 'rental_term gate rejected');
    continue;
  }

  const filterResult = await evaluateFilters(opts.cfg.filters.filters, current);
  if (!filterResult.passed) {
    log.debug({ listing_id: current.id, reason: filterResult.reason }, 'filtered out');
    continue;
  }

  const score = await scoreListing(opts.cfg.scoring.scoring, current);
  opts.db._raw
    .prepare('INSERT INTO scores (listing_id, scored_at, final, breakdown) VALUES (?,?,?,?)')
    .run(current.id, Date.now(), score.final, JSON.stringify(score.breakdown));
  if (score.final < opts.cfg.scoring.notify.threshold) {
    log.debug({ listing_id: current.id, score: score.final }, 'below threshold');
    continue;
  }

  const verdict = shouldNotify(upsertResult, current);
  if (verdict.suppress) {
    log.debug(
      { listing_id: current.id, canonical_key: current.canonical_key },
      'cross-source dedup suppressed',
    );
    continue;
  }
  if (!opts.quota.tryConsume()) {
    log.info({ listing_id: current.id, score: score.final }, 'quota exhausted; skipping notify');
    continue;
  }
  const event = { listing: current, score, also_seen_on: verdict.also_seen_on };
  for (const n of opts.notifiers) await notifySafely(n, event, opts);
  log.info({ listing_id: current.id, score: score.final, isNew: upsertResult.isNew }, 'notified');
}
```

- [ ] **Step 2: Run server tests**

Run: `pnpm --filter @wabe/server test`
Expected: PASS. `pipeline-dedup.integration.test.ts` may still pass if its expectations align; if not, fix in Task 8.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/pipeline.ts
git commit -m "server(pipeline): single merge call, enrich only on isNew, pure shouldNotify"
```

---

## Task 5: TS migration runner — collapse `listings_old` into `listings`

**Files:**
- Create: `packages/db/src/collapse-listings.ts`
- Modify: `packages/db/src/migrate.ts`
- Test: `packages/db/test/collapse-listings.test.ts`

The runner is invoked from `migrate.ts` after every `.sql` file applies, but only acts when `listings_old` exists. It folds rows through `resolveFields()`, rebuilds dependent-table FKs, repopulates `listings_fts`, and drops `listings_old`. Idempotent on partial-failure restart.

- [ ] **Step 1: Write the failing test — three same-canonical_key rows collapse to one**

`packages/db/test/collapse-listings.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalKey, SOURCE_PRIORITY_DEFAULTS } from '@wabe/core';
import { openDb, migrate, type WabeDb } from '../src/index.js';

let dir: string;
function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-collapse-'));
  const db = openDb(join(dir, 'test.db'));
  return db;
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function pre0005Schema(db: WabeDb): void {
  // Apply migrations 0001..0004 by running the existing migrate() up to 0004
  // (the test fixture seeds rows then re-invokes migrate() which applies 0005).
  // Simplest: apply ALL migrations, then drop rows + recreate via SQL to
  // simulate a pre-collapse state. The runner only fires when `listings_old` exists,
  // so the post-migrate fixture builds `listings_old` directly.
  migrate(db);
}

function seedLegacy(db: WabeDb, rows: Array<{ id: string; source: string; url: string; payload: string; canonical_key: string; source_priority: number; first_seen_at: number; last_seen_at: number; }>): void {
  // Recreate the pre-collapse state by moving the post-0005 listings table
  // into the same shape `listings_old` has after 0005 SQL runs.
  db._raw.exec('DROP TABLE IF EXISTS listings_old');
  db._raw.exec(`CREATE TABLE listings_old AS SELECT * FROM listings WHERE 0`);
  // Add the legacy columns missing from current listings shape if needed.
  for (const r of rows) {
    db._raw.prepare(
      'INSERT INTO listings_old (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, r.source, r.url, r.id, r.payload, r.first_seen_at, r.last_seen_at, 'new', r.canonical_key, r.source_priority, JSON.stringify([r.source]));
  }
  db._raw.exec('DELETE FROM listings');
}

function legacyPayload(id: string, source: string, url: string, ck: string, priority: number, firstSeen: number): string {
  return JSON.stringify({
    id, source, source_priority: priority,
    url, canonical_key: ck,
    first_seen_at: new Date(firstSeen).toISOString(),
    last_seen_at: new Date(firstSeen).toISOString(),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5, area_m2: 112, floor: null, total_floors: null, built_year: null, renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {}, description: null, photos: [], available_from: null, lease_until: null,
    rental_term: 'unknown', agency: null, contact: {}, enriched: {}, extra: {},
    seen_on_sources: [source],
  });
}

describe('collapseListings runner', () => {
  it('folds three rows sharing a canonical_key into one, repoints score FKs, drops listings_old', () => {
    const db = freshDb();
    pre0005Schema(db);

    const ck = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 112, price_total: 3200, url: 'https://flatfox.ch/1' });
    seedLegacy(db, [
      { id: 'flatfox:1', source: 'source-flatfox', url: 'https://flatfox.ch/1', canonical_key: ck, source_priority: SOURCE_PRIORITY_DEFAULTS['source-flatfox'] ?? 80, first_seen_at: 1700000000000, last_seen_at: 1700000000000, payload: legacyPayload('flatfox:1', 'source-flatfox', 'https://flatfox.ch/1', ck, 80, 1700000000000) },
      { id: 'realadvisor:2', source: 'source-realadvisor', url: 'https://realadvisor.ch/2', canonical_key: ck, source_priority: 50, first_seen_at: 1700000100000, last_seen_at: 1700000100000, payload: legacyPayload('realadvisor:2', 'source-realadvisor', 'https://realadvisor.ch/2', ck, 50, 1700000100000) },
      { id: 'homegate:3', source: 'source-homegate', url: 'https://homegate.ch/3', canonical_key: ck, source_priority: 70, first_seen_at: 1700000200000, last_seen_at: 1700000200000, payload: legacyPayload('homegate:3', 'source-homegate', 'https://homegate.ch/3', ck, 70, 1700000200000) },
    ]);
    db._raw.prepare('INSERT INTO scores (listing_id, scored_at, final, breakdown) VALUES (?,?,?,?)').run('realadvisor:2', 1700000100000, 50, '{}');

    // Re-invoke migrate(): 0005 already applied, so this fires only the runner.
    const { collapseListings } = require('../src/collapse-listings.js');
    collapseListings(db);

    const rows = db._raw.prepare('SELECT id, source, source_priority, seen_on_sources FROM listings').all() as Array<{ id: string; source: string; source_priority: number; seen_on_sources: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ck);
    expect(rows[0].source).toBe('source-flatfox');           // priority-wins
    expect(JSON.parse(rows[0].seen_on_sources).sort()).toEqual(['source-flatfox', 'source-homegate', 'source-realadvisor']);

    const score = db._raw.prepare('SELECT listing_id FROM scores').get() as { listing_id: string };
    expect(score.listing_id).toBe(ck);

    const old = db._raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings_old'").get();
    expect(old).toBeUndefined();
  });

  it('is idempotent — re-running after partial completion is safe', () => {
    const db = freshDb();
    pre0005Schema(db);
    const ck = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 112, price_total: 3200, url: 'https://flatfox.ch/1' });
    seedLegacy(db, [
      { id: 'flatfox:1', source: 'source-flatfox', url: 'https://flatfox.ch/1', canonical_key: ck, source_priority: 80, first_seen_at: 1700000000000, last_seen_at: 1700000000000, payload: legacyPayload('flatfox:1', 'source-flatfox', 'https://flatfox.ch/1', ck, 80, 1700000000000) },
    ]);

    const { collapseListings } = require('../src/collapse-listings.js');
    collapseListings(db);
    collapseListings(db);   // no-op the second time (no listings_old, no error).
    const rows = db._raw.prepare('SELECT id FROM listings').all();
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/db test collapse-listings.test`
Expected: FAIL — `collapse-listings.js` module not found.

- [ ] **Step 3: Implement the runner**

`packages/db/src/collapse-listings.ts`:

```ts
import { Listing, type RawListing, resolveFields } from '@wabe/core';
import type { WabeDb } from './client.js';

interface LegacyRow {
  id: string; source: string; url: string; payload: string;
  canonical_key: string; source_priority: number;
  first_seen_at: number; last_seen_at: number;
}

/**
 * Fold rows from `listings_old` into the new `listings` table via resolveFields().
 *
 * Rebuilds dependent FKs (scores, notifications, failures.listing_id) by mapping
 * each legacy row's id → its canonical_key (the surviving row's id).
 *
 * Idempotent: if `listings_old` doesn't exist, the runner exits silently. Safe to
 * re-invoke after a crash because the rebuild is wrapped in a single transaction;
 * SQLite rolls back partial state on throw.
 */
export function collapseListings(db: WabeDb): void {
  const raw = db._raw;
  const tableExists = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings_old'")
    .get();
  if (!tableExists) return;

  raw.transaction(() => {
    const rows = raw
      .prepare<[], LegacyRow>(
        'SELECT id, source, url, payload, canonical_key, source_priority, first_seen_at, last_seen_at FROM listings_old ORDER BY canonical_key, first_seen_at ASC',
      )
      .all();

    // Group by canonical_key; older first_seen_at first within a group.
    const groups = new Map<string, LegacyRow[]>();
    for (const r of rows) {
      const list = groups.get(r.canonical_key) ?? [];
      list.push(r);
      groups.set(r.canonical_key, list);
    }

    // Map legacy id → canonical_key for FK rebuild.
    const idMap = new Map<string, string>();

    for (const [ck, group] of groups) {
      let merged: Listing | null = null;
      for (const row of group) {
        const r = listingToRaw(JSON.parse(row.payload), row);
        if (!merged) {
          merged = materialise(r, ck, row.source_priority);
        } else {
          const out = resolveFields(merged, r, row.source_priority);
          merged = out.next;
        }
        idMap.set(row.id, ck);
      }
      if (!merged) continue;

      // Upsert into new listings table — idempotent on re-run.
      const existing = raw.prepare('SELECT id FROM listings WHERE id = ?').get(ck);
      if (existing) {
        raw.prepare(
          'UPDATE listings SET source=?, url=?, payload=?, last_seen_at=?, source_priority=?, seen_on_sources=? WHERE id=?',
        ).run(
          merged.source, merged.url, JSON.stringify(merged),
          merged.last_seen_at.getTime(), merged.source_priority,
          JSON.stringify(merged.seen_on_sources), ck,
        );
      } else {
        raw.prepare(
          'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          ck, merged.source, merged.url, ck, JSON.stringify(merged),
          merged.first_seen_at.getTime(), merged.last_seen_at.getTime(), 'new',
          ck, merged.source_priority, JSON.stringify(merged.seen_on_sources),
        );
      }

      // Repopulate FTS for this row.
      raw.prepare('DELETE FROM listings_fts WHERE id = ?').run(ck);
      raw.prepare('INSERT INTO listings_fts (id, description) VALUES (?, ?)').run(ck, merged.description ?? '');
    }

    // Rebuild dependent-table FKs.
    repointFks(raw, idMap);

    raw.exec('DROP TABLE listings_old');
  })();
}

function repointFks(raw: WabeDb['_raw'], idMap: Map<string, string>): void {
  const update = raw.prepare('UPDATE OR IGNORE {table} SET listing_id = ? WHERE listing_id = ?');
  const tables = ['scores', 'notifications', 'failures'];
  for (const table of tables) {
    const stmt = raw.prepare(`UPDATE OR IGNORE ${table} SET listing_id = ? WHERE listing_id = ?`);
    for (const [oldId, newId] of idMap) {
      if (oldId === newId) continue;
      stmt.run(newId, oldId);
    }
  }
}

/**
 * Convert a legacy materialised Listing payload back into a RawListing so it can
 * be fed through `resolveFields`. The legacy row already includes id/source/url,
 * and we treat its first_seen_at/last_seen_at as authoritative.
 */
function listingToRaw(p: unknown, row: LegacyRow): RawListing {
  const parsed = Listing.parse(p);
  return {
    id: parsed.id,
    source: parsed.source,
    url: parsed.url,
    first_seen_at: parsed.first_seen_at,
    last_seen_at: parsed.last_seen_at,
    price: parsed.price,
    rooms: parsed.rooms,
    area_m2: parsed.area_m2,
    floor: parsed.floor,
    total_floors: parsed.total_floors,
    built_year: parsed.built_year,
    renovated_year: parsed.renovated_year,
    location: parsed.location,
    features: parsed.features,
    description: parsed.description,
    photos: parsed.photos,
    available_from: parsed.available_from,
    lease_until: parsed.lease_until,
    rental_term: parsed.rental_term,
    agency: parsed.agency,
    contact: parsed.contact,
    enriched: {
      ...parsed.enriched,
      external_ids: {
        ...((parsed.enriched as Record<string, unknown>).external_ids as Record<string, string> | undefined ?? {}),
        [parsed.source]: parsed.id,
      },
    },
    extra: parsed.extra,
  };
}

function materialise(raw: RawListing, ck: string, priority: number): Listing {
  return Listing.parse({
    ...raw,
    id: ck,
    canonical_key: ck,
    source_priority: priority,
    first_seen_at: raw.first_seen_at ?? new Date(),
    last_seen_at: raw.last_seen_at ?? new Date(),
    seen_on_sources: [raw.source],
  });
}
```

- [ ] **Step 4: Invoke from `migrate.ts`**

Edit `packages/db/src/migrate.ts`. After the `for (const f of files) { … }` loop (before `return`), call the runner so that 0005's SQL setup is followed by the TS fold inside the same migration's transaction window:

Replace:
```ts
    raw.transaction(() => {
      raw.exec(sql);
      raw.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    newlyApplied.push(f);
```
With:
```ts
    raw.transaction(() => {
      raw.exec(sql);
      if (f === '0005_collapse_canonical.sql') {
        // Collapse listings_old → listings inside the same migration transaction
        // so a failure rolls the SQL back and the migration is retried.
        const { collapseListings } = require('./collapse-listings.js') as typeof import('./collapse-listings.js');
        collapseListings(db);
      }
      raw.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    newlyApplied.push(f);
```

Also re-export the runner from `packages/db/src/index.ts` for the rollback CLI:

```ts
export { collapseListings } from './collapse-listings.js';
```

- [ ] **Step 5: Run db tests**

Run: `pnpm --filter @wabe/db test`
Expected: PASS (existing migrate.test passes; new collapse-listings.test passes).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/collapse-listings.ts packages/db/src/migrate.ts packages/db/src/index.ts packages/db/test/collapse-listings.test.ts
git commit -m "db(0005): TS runner folds listings_old via resolveFields + repoints FKs"
```

---

## Task 6: `wabe db rollback-collapse` CLI

**Files:**
- Create: `packages/cli/src/commands/db.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Implement the subcommand**

`packages/cli/src/commands/db.ts`:

```ts
import type { Command } from 'commander';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

/**
 * `wabe db rollback-collapse`: reverse migration 0005 by swapping
 * `listings_legacy` back into `listings`. Refuses if migrations later than 0005
 * are recorded — the schema may have diverged. Removes the 0005 row from
 * `_migrations` so the migrator re-applies the collapse on next start.
 */
export function registerDb(prog: Command): void {
  const db = prog.command('db').description('Database maintenance subcommands');

  db.command('rollback-collapse')
    .description('Reverse migration 0005_collapse_canonical (restores listings_legacy)')
    .option('--yes', 'skip confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      const paths = resolvePaths(prog.opts());
      const db = openDb(paths.dbFile);

      const hasLegacy = db._raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings_legacy'")
        .get();
      if (!hasLegacy) {
        console.error('Error: listings_legacy table is missing — nothing to roll back.');
        process.exit(1);
      }

      const later = db._raw
        .prepare<[], { filename: string }>(
          "SELECT filename FROM _migrations WHERE filename > '0005_collapse_canonical.sql' ORDER BY filename",
        )
        .all();
      if (later.length > 0) {
        console.error(`Error: migrations later than 0005 are applied — rollback aborted:\n  ${later.map((r) => r.filename).join('\n  ')}`);
        process.exit(1);
      }

      if (!opts.yes) {
        process.stdout.write('This will replace the current `listings` table with the pre-collapse snapshot. Continue? [y/N] ');
        const answer = await new Promise<string>((res) => {
          process.stdin.once('data', (b) => res(b.toString().trim().toLowerCase()));
        });
        if (answer !== 'y' && answer !== 'yes') {
          console.log('Aborted.');
          return;
        }
      }

      db._raw.transaction(() => {
        db._raw.exec('DROP TABLE listings');
        db._raw.exec('ALTER TABLE listings_legacy RENAME TO listings');
        db._raw.exec('DELETE FROM listings_fts');
        db._raw.prepare("DELETE FROM _migrations WHERE filename = ?").run('0005_collapse_canonical.sql');
      })();

      console.log('Rollback complete. Re-run `wabe migrate` to re-apply the collapse.');
    });
}
```

- [ ] **Step 2: Register the command**

Edit `packages/cli/src/index.ts`. Add an import next to the others:

```ts
import { registerDb } from './commands/db.js';
```

And register it next to the other `register*` calls:

```ts
registerDb(program);
```

- [ ] **Step 3: Smoke-test manually (optional — no automated test for the prompt path)**

Run:
```bash
pnpm build && WABE_DATA_DIR=/tmp/wabe-rollback-smoke ./packages/cli/dist/index.js db rollback-collapse --yes
```
Expected: errors with `listings_legacy table is missing` on a fresh data dir. Verifies the guard fires before any destructive SQL.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/db.ts packages/cli/src/index.ts
git commit -m "cli(db): wabe db rollback-collapse subcommand"
```

---

## Task 7: Pipeline + dedup integration test — notify-once across sources

**Files:**
- Modify: `packages/server/test/pipeline-dedup.integration.test.ts`

Update the existing test (or add the scenarios below if the file's structure permits) to assert:

1. Source A (priority 80) emits a canonical listing → notifier called once.
2. Source B (priority 50) emits the same `canonical_key` with extra photos + phone → row updates, notifier NOT called again.
3. Source C (priority 70) emits same `canonical_key` → still no notify; merged row's `source` stays as A (80 > 70); `seen_on_sources` is `[A, B, C]` sorted.

- [ ] **Step 1: Add the assertion block**

Skim the existing `pipeline-dedup.integration.test.ts` and adapt one of the existing scenarios (or add a new `describe('notify-once across sources')` block). Use stub source plugins that yield one `RawListing` each, and a stub notifier that pushes into an `events` array. After the three `runOnce()` calls, assert:

```ts
expect(notifier.sent).toHaveLength(1);
expect(notifier.sent[0].listing.source).toBe('source-flatfox');
expect(notifier.sent[0].also_seen_on).toEqual([]);   // first arrival
const row = db._raw.prepare('SELECT seen_on_sources, source FROM listings WHERE canonical_key = ?').get(ck) as { seen_on_sources: string; source: string };
expect(JSON.parse(row.seen_on_sources).sort()).toEqual(['source-flatfox', 'source-homegate', 'source-realadvisor']);
expect(row.source).toBe('source-flatfox');
```

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter @wabe/server test pipeline-dedup`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/pipeline-dedup.integration.test.ts
git commit -m "server(test): pipeline integration covers notify-once across three sources"
```

---

## Task 8: Schema doc-only update + README + CLAUDE.md

**Files:**
- Modify: `packages/core/src/schemas/listing.ts` (doc comments only)
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `listing.ts` field-level doc comments**

Add or revise the JSDoc above the relevant fields in `packages/core/src/schemas/listing.ts` to reflect post-collapse semantics. No structural change. Examples:

```ts
/** = canonical_key. One row per logical listing; the historical per-source id is preserved in `enriched.external_ids`. */
id: z.string(),
/** Authoritative source (highest source_priority among contributors; ties broken by older first_seen_at). */
source: z.string(),
/** URL from the authoritative source. */
url: z.string().url(),
```

- [ ] **Step 2: Update `README.md` — replace any "per-source row" language with the canonical-row model**

Search for `source_id` / "per-source" / "one row per source" and rephrase. Add one short paragraph under "Architecture":

```markdown
### Canonical-row model

Wabe stores **one row per logical listing**, keyed by `canonical_key`. When a
second source reports the same listing, fields are merged via a deterministic
priority-wins reducer (`@wabe/core/resolveFields`): the authoritative `source`
and `url` follow the highest-priority contributor, scalars use priority-wins
with null-skip, photos union, and `enriched.*` deep-merge. Notifications fire
only on the first canonical-row insert.
```

- [ ] **Step 3: Update `CLAUDE.md` — "Architecture summary"**

Locate the `packages/server/src/dedupe.ts` line under "Architecture summary" and rephrase. Also tweak the sentence that mentions `(source, source_id)` rows to read:

```markdown
- `packages/server/src/dedupe.ts` — `mergeUpsertCanonical(db, raw, ck)`:
  one row per logical listing keyed by `canonical_key`; second-source observations
  fold through `resolveFields` (in `@wabe/core`). Notifies only on the first
  canonical-row insert.
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/schemas/listing.ts README.md CLAUDE.md
git commit -m "docs: canonical-row model in README + CLAUDE.md; clarify schema comments"
```

---

## Task 9: Final verification — full CI

- [ ] **Step 1: Run the full CI suite**

Run: `pnpm ci`
Expected: lint + format:check + typecheck + test all green.

- [ ] **Step 2: Manual smoke test against a real DB**

```bash
rm -rf /tmp/wabe-collapse-smoke && \
WABE_DATA_DIR=/tmp/wabe-collapse-smoke pnpm wabe migrate && \
sqlite3 /tmp/wabe-collapse-smoke/wabe.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```
Expected output includes `listings`, `listings_legacy`, `listings_fts`, and NOT `listings_old`. Verifies the runner ran and cleaned up.

- [ ] **Step 3: Manual rollback smoke**

```bash
WABE_DATA_DIR=/tmp/wabe-collapse-smoke pnpm wabe db rollback-collapse --yes && \
sqlite3 /tmp/wabe-collapse-smoke/wabe.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```
Expected: `listings_legacy` is gone (renamed back to `listings`); `_migrations` no longer lists `0005_collapse_canonical.sql`.

- [ ] **Step 4: Commit any incidental fixes**

```bash
git add -p   # only the incidental fixes
git commit -m "fix: incidental adjustments surfaced by collapse migration smoke test"
```

---

## Self-review checklist (run before handing off)

- Spec coverage:
  - resolveFields → Task 1 ✓
  - mergeUpsertCanonical → Task 2 ✓
  - shouldNotify pure → Task 3 ✓
  - pipeline merge-once + enrich-on-isNew → Task 4 ✓
  - migration SQL → Task 0 ✓
  - TS runner + FK repoint + FTS rebuild → Task 5 ✓
  - rollback CLI → Task 6 ✓
  - integration "notify once across N sources" → Task 7 ✓
  - schema/docs updates → Task 8 ✓
- Placeholder scan: no "TBD" / "implement appropriate" / unspecified test bodies — every step shows code or a concrete command.
- Type consistency: `mergeUpsertCanonical`, `readListing`, `writeListingPayload`, `UpsertResult`, `DedupVerdict`, `resolveFields` signatures match across tasks; the integration test's column names (`seen_on_sources`, `source`) match the migration SQL.
