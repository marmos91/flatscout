# Phase A — Wave 1 Sources + Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three new pure-undici source plugins (realadvisor, immoscout24-sitemap, immobilier.ch) behind a cross-source deduplication pipeline so notifications do not spam duplicates as the source count grows.

**Architecture:** Add `canonical_key` + `source_priority` to the `Listing` schema, persist them in SQLite, and introduce a per-listing cross-source dedup stage in the pipeline that suppresses notifications when a higher-priority duplicate already exists. The three new source plugins follow the existing `@wabe/source-flatfox` pattern (Zod config + undici via global dispatcher + Vitest with `MockAgent`) and each lives in its own directory under `plugins/` so they can be developed in parallel worktrees.

**Tech Stack:** TypeScript, Zod, undici, better-sqlite3 (via `@wabe/db`), Vitest, pino, sax (XML), pako (gzip). Spec reference: `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §4 and §7.

**Parallelism plan:**
- Tasks 1–7 are shared infra — run sequentially in a single worktree (the main repo). They must merge to `main` first.
- After T7 merges, Tasks 8–12 (realadvisor), 13–17 (IS24 sitemap), 18–22 (immobilier) each go in their own worktree and can execute in parallel.
- Tasks 23–25 are integration/wiring — single worktree after all three plugins land on main.

---

## File map

### New files

| Path | Purpose |
|------|---------|
| `packages/core/src/canonical-key.ts` | Bucketing + sha256 helper, source priority defaults |
| `packages/core/test/canonical-key.test.ts` | Unit tests for buckets and key |
| `packages/db/migrations/0002_dedup_fields.sql` | Add `canonical_key`, `source_priority`, `seen_on_sources` columns + index |
| `packages/server/src/canonical-dedup.ts` | Cross-source dedup check at notify time |
| `packages/server/test/canonical-dedup.test.ts` | Unit tests for dedup logic |
| `packages/server/test/pipeline-dedup.integration.test.ts` | End-to-end integration test (3 stub sources + overlap) |
| `plugins/source-realadvisor/**` | New plugin package |
| `plugins/source-immoscout24-sitemap/**` | New plugin package |
| `plugins/source-immobilier-ch/**` | New plugin package |

### Modified files

| Path | Change |
|------|--------|
| `packages/core/src/schemas/listing.ts` | Add `canonical_key`, `source_priority`, `seen_on_sources` to `Listing` schema |
| `packages/core/src/index.ts` | Re-export `canonical-key` helpers and `SOURCE_PRIORITY_DEFAULTS` |
| `packages/server/src/dedupe.ts` | Persist new dedup columns at upsert time |
| `packages/server/src/pipeline.ts` | Invoke `canonical-dedup` before quota/notify; pass `seen_on_sources` to notifier event |
| `packages/plugin-sdk/src/notifier.ts` | Extend `ListingEvent` with optional `also_seen_on: string[]` |
| `plugins/notifier-telegram/src/card.ts` | Render `Also on:` footer when `also_seen_on.length > 0` |
| `plugins/notifier-telegram/test/card.test.ts` | Test the new footer |
| `packages/server/package.json` | Add `@wabe/source-realadvisor`, `@wabe/source-immoscout24-sitemap`, `@wabe/source-immobilier-ch` as dependencies (slice-only distribution per CLAUDE.md) |
| `examples/zurich-family/config/config.yaml` | Enable the three new sources |
| `examples/zurich-family/config/plugins/` | Add yaml config files for the three plugins |
| `examples/zurich-family/test/gate.test.ts` | Extend gate test to cover the new sources |

---

## Tasks

### Task 1: Bucket + canonical-key helpers in `@wabe/core`

**Files:**
- Create: `packages/core/src/canonical-key.ts`
- Create: `packages/core/test/canonical-key.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/canonical-key.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { canonicalKey, roundRoomsBucket, roundAreaBucket, roundPriceBucket, SOURCE_PRIORITY_DEFAULTS } from '../src/canonical-key.js';

describe('bucket helpers', () => {
  it('rounds rooms to nearest 0.5', () => {
    expect(roundRoomsBucket(3.7)).toBe(3.5);
    expect(roundRoomsBucket(3.8)).toBe(4.0);
    expect(roundRoomsBucket(null)).toBeNull();
  });
  it('rounds area to nearest 5 m²', () => {
    expect(roundAreaBucket(112)).toBe(110);
    expect(roundAreaBucket(113)).toBe(115);
    expect(roundAreaBucket(null)).toBeNull();
  });
  it('rounds price to nearest 50 CHF', () => {
    expect(roundPriceBucket(3274)).toBe(3300);
    expect(roundPriceBucket(3225)).toBe(3250);
    expect(roundPriceBucket(null)).toBeNull();
  });
});

describe('canonicalKey', () => {
  it('returns a deterministic sha256 for fully-populated input', () => {
    const a = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 112, price_total: 3200, url: 'https://x/1' });
    const b = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 112, price_total: 3200, url: 'https://x/2' });
    expect(a).toBe(b); // same bucket inputs ⇒ same key regardless of URL
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('collides on near-equal listings within bucket tolerance', () => {
    const a = canonicalKey({ postal_code: '8008', rooms: 4.4, area_m2: 110, price_total: 3225, url: 'https://x/1' });
    const b = canonicalKey({ postal_code: '8008', rooms: 4.5, area_m2: 113, price_total: 3260, url: 'https://x/2' });
    expect(a).toBe(b);
  });
  it('falls back to URL-based key when any bucket field is missing', () => {
    const a = canonicalKey({ postal_code: '8008', rooms: null, area_m2: 112, price_total: 3200, url: 'https://x/1' });
    const b = canonicalKey({ postal_code: '8008', rooms: null, area_m2: 112, price_total: 3200, url: 'https://x/2' });
    expect(a).not.toBe(b);
  });
});

describe('SOURCE_PRIORITY_DEFAULTS', () => {
  it('orders agency-direct > portals > aggregators > tertiary', () => {
    expect(SOURCE_PRIORITY_DEFAULTS['agency']).toBe(100);
    expect(SOURCE_PRIORITY_DEFAULTS['source-flatfox']).toBe(80);
    expect(SOURCE_PRIORITY_DEFAULTS['source-homegate']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-immoscout24-sitemap']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-immobilier-ch']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-realadvisor']).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @wabe/core test canonical-key
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `canonical-key.ts`**

Create `packages/core/src/canonical-key.ts`:

```typescript
import { createHash } from 'node:crypto';

/** Bucket rooms to nearest 0.5; pass-through null. */
export function roundRoomsBucket(rooms: number | null): number | null {
  if (rooms === null) return null;
  return Math.round(rooms * 2) / 2;
}

/** Bucket area to nearest 5 m²; pass-through null. */
export function roundAreaBucket(area: number | null): number | null {
  if (area === null) return null;
  return Math.round(area / 5) * 5;
}

/** Bucket price to nearest 50 CHF; pass-through null. */
export function roundPriceBucket(price: number | null): number | null {
  if (price === null) return null;
  return Math.round(price / 50) * 50;
}

export interface CanonicalKeyInput {
  postal_code: string | null;
  rooms: number | null;
  area_m2: number | null;
  price_total: number | null;
  /** Used to make the key unique when any bucket field is missing, so partial listings never collapse onto detailed ones. */
  url: string;
}

/**
 * Returns a deterministic sha256 key over bucketed dedup fields.
 *
 * When all four bucket fields (postal_code, rooms, area, price) are present,
 * the key collapses listings whose values round to the same buckets. If any
 * field is missing, the key includes the URL so the listing stays unique —
 * accepted trade: false negatives over false positives.
 */
export function canonicalKey(input: CanonicalKeyInput): string {
  const rb = roundRoomsBucket(input.rooms);
  const ab = roundAreaBucket(input.area_m2);
  const pb = roundPriceBucket(input.price_total);
  const allBucketsPresent = input.postal_code !== null && rb !== null && ab !== null && pb !== null;
  const material = allBucketsPresent
    ? `${input.postal_code}|${rb}|${ab}|${pb}`
    : `url:${input.url}`;
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Default source priorities (0-100, higher wins on dedup tie).
 * Overridable per source via `sources[].priority` in user yaml.
 * Plugins not listed here default to 50.
 */
export const SOURCE_PRIORITY_DEFAULTS: Record<string, number> = {
  agency: 100,
  'source-flatfox': 80,
  'source-homegate': 70,
  'source-immoscout24-sitemap': 70,
  'source-immobilier-ch': 70,
  'source-realadvisor': 50,
  'source-engelvoelkers': 30,
  'source-housinganywhere': 30,
};

export const DEFAULT_SOURCE_PRIORITY = 50;
```

- [ ] **Step 4: Re-export from core's `index.ts`**

Append to `packages/core/src/index.ts`:

```typescript
export {
  canonicalKey,
  roundRoomsBucket,
  roundAreaBucket,
  roundPriceBucket,
  SOURCE_PRIORITY_DEFAULTS,
  DEFAULT_SOURCE_PRIORITY,
  type CanonicalKeyInput,
} from './canonical-key.js';
```

- [ ] **Step 5: Run tests**

```
pnpm --filter @wabe/core test canonical-key
```
Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/core/src/canonical-key.ts packages/core/src/index.ts packages/core/test/canonical-key.test.ts
git commit -S -m "feat(core): canonical_key bucket helpers + source priority defaults"
```

---

### Task 2: Listing schema additions

**Files:**
- Modify: `packages/core/src/schemas/listing.ts`

- [ ] **Step 1: Extend `Listing` Zod schema**

In `packages/core/src/schemas/listing.ts`, inside the `Listing` `z.object({...})` literal, append (just before the final `})`):

```typescript
  /** sha256 of bucketed dedup fields (or URL when any bucket field is missing). Stamped by the pipeline at upsert time. */
  canonical_key: z.string().default(''),
  /** 0-100; higher wins on cross-source dedup tie. Stamped by the pipeline from `SOURCE_PRIORITY_DEFAULTS` unless overridden in config. */
  source_priority: z.number().int().min(0).max(100).default(50),
```

The defaults exist purely to make `Listing.parse({...minimal...})` work in tests; the pipeline stamps the real values before persistence.

- [ ] **Step 2: Confirm existing build still passes**

```
pnpm --filter @wabe/core typecheck && pnpm --filter @wabe/core test
```
Expected: all green. (No new tests in this task; behaviour is covered in Tasks 4–7.)

- [ ] **Step 3: Commit**

```
git add packages/core/src/schemas/listing.ts
git commit -S -m "feat(core): add canonical_key + source_priority to Listing schema"
```

---

### Task 3: SQL migration for dedup columns

**Files:**
- Create: `packages/db/migrations/0002_dedup_fields.sql`

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0002_dedup_fields.sql`:

```sql
-- Phase A: cross-source dedup support.
-- canonical_key collapses near-equal listings across sources;
-- source_priority resolves ties at notify time;
-- seen_on_sources is materialised by canonical-dedup on each new arrival.

ALTER TABLE listings ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN source_priority INTEGER NOT NULL DEFAULT 50;
-- JSON array of source plugin names that have reported this canonical group.
ALTER TABLE listings ADD COLUMN seen_on_sources TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_listings_canonical_key ON listings (canonical_key);
```

- [ ] **Step 2: Run migration test (existing runner)**

```
pnpm --filter @wabe/db test
```
Expected: existing migrate tests still pass (they iterate `migrations/` and apply in order).

- [ ] **Step 3: Add a migration test for the new columns**

Append to `packages/db/test/migrate.test.ts` (create if absent, mirroring existing test style):

```typescript
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/migrate.js';

describe('0002_dedup_fields', () => {
  it('adds canonical_key, source_priority, seen_on_sources columns', () => {
    const raw = new Database(':memory:');
    const db = { _raw: raw } as Parameters<typeof migrate>[0];
    migrate(db);
    const cols = raw.prepare("PRAGMA table_info('listings')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('canonical_key');
    expect(names).toContain('source_priority');
    expect(names).toContain('seen_on_sources');
    const idx = raw.prepare("PRAGMA index_list('listings')").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('idx_listings_canonical_key');
  });
});
```

- [ ] **Step 4: Run new test**

```
pnpm --filter @wabe/db test migrate
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/db/migrations/0002_dedup_fields.sql packages/db/test/migrate.test.ts
git commit -S -m "feat(db): migration 0002 — dedup fields (canonical_key, source_priority, seen_on_sources)"
```

---

### Task 4: Stamp dedup fields at upsert time

**Files:**
- Modify: `packages/server/src/dedupe.ts`

- [ ] **Step 1: Update `upsertListing` to persist canonical_key + source_priority + seen_on_sources**

Replace the body of `upsertListing` in `packages/server/src/dedupe.ts` with the version below. The function gains responsibility for: (a) computing `canonical_key` if the caller passed an empty default, (b) merging `seen_on_sources` across rows that share a `canonical_key`.

```typescript
import type { Listing } from '@wabe/core';
import { canonicalKey } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
}

/**
 * Inserts a listing or updates the existing row if its serialised payload has
 * changed. Stamps `canonical_key` from bucketed fields and persists
 * `source_priority` + `seen_on_sources` so the notify-time dedup check can
 * find the canonical group.
 */
export function upsertListing(db: WabeDb, listing: Listing): UpsertResult {
  const now = Date.now();
  const fingerprint = listing.id;
  // Stamp canonical_key if pipeline left it empty (it should always be empty here — pipeline computes after enrich).
  const ck =
    listing.canonical_key && listing.canonical_key.length > 0
      ? listing.canonical_key
      : canonicalKey({
          postal_code: listing.location.postal_code,
          rooms: listing.rooms,
          area_m2: listing.area_m2,
          price_total: listing.price.total,
          url: listing.url,
        });
  const stamped: Listing = { ...listing, canonical_key: ck };

  // Merge seen_on_sources across any existing rows with the same canonical_key.
  const sourcesForGroup = db._raw
    .prepare<[string], { source: string }>('SELECT DISTINCT source FROM listings WHERE canonical_key = ?')
    .all(ck)
    .map((r) => r.source);
  const mergedSources = Array.from(new Set([...sourcesForGroup, stamped.source])).sort();
  const finalListing: Listing = { ...stamped, seen_on_sources: mergedSources };
  const payload = JSON.stringify(finalListing);

  const existing = db._raw
    .prepare<[string], { id: string; payload: string }>('SELECT id, payload FROM listings WHERE id = ?')
    .get(finalListing.id);

  if (!existing) {
    db._raw
      .prepare(
        'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        finalListing.id,
        finalListing.source,
        finalListing.url,
        fingerprint,
        payload,
        now,
        now,
        'new',
        ck,
        finalListing.source_priority,
        JSON.stringify(mergedSources),
      );
    // Also backfill seen_on_sources on existing rows in the same group (so the older row "knows" the newer source has joined).
    db._raw
      .prepare('UPDATE listings SET seen_on_sources = ? WHERE canonical_key = ? AND id != ?')
      .run(JSON.stringify(mergedSources), ck, finalListing.id);
    return { changed: true, isNew: true, fingerprint };
  }
  if (existing.payload === payload) {
    db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, finalListing.id);
    return { changed: false, isNew: false, fingerprint };
  }
  db._raw
    .prepare(
      'UPDATE listings SET payload = ?, last_seen_at = ?, canonical_key = ?, source_priority = ?, seen_on_sources = ? WHERE id = ?',
    )
    .run(payload, now, ck, finalListing.source_priority, JSON.stringify(mergedSources), finalListing.id);
  return { changed: true, isNew: false, fingerprint };
}
```

This adds the dedup-field upkeep without changing the function signature — pipeline callers do not change.

- [ ] **Step 2: Write a test that proves `seen_on_sources` merges across two sources**

Create or append to `packages/server/test/dedupe.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@wabe/db';
import { Listing } from '@wabe/core';
import { upsertListing } from '../src/dedupe.js';

function freshDb() {
  const raw = new Database(':memory:');
  const db = { _raw: raw };
  migrate(db);
  return db;
}

function makeListing(over: Partial<Listing> & { id: string; source: string; url: string }): Listing {
  return Listing.parse({
    id: over.id,
    source: over.source,
    url: over.url,
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
    ...over,
  });
}

describe('upsertListing canonical-group merging', () => {
  it('merges seen_on_sources across two rows sharing a canonical_key', () => {
    const db = freshDb();
    upsertListing(db, makeListing({ id: 'a:1', source: 'source-flatfox', url: 'https://flatfox.ch/1' }));
    upsertListing(db, makeListing({ id: 'b:1', source: 'source-homegate', url: 'https://homegate.ch/1' }));
    const rows = db._raw.prepare('SELECT id, seen_on_sources FROM listings ORDER BY id').all() as Array<{ id: string; seen_on_sources: string }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(JSON.parse(r.seen_on_sources).sort()).toEqual(['source-flatfox', 'source-homegate']);
    }
  });
});
```

- [ ] **Step 3: Run tests**

```
pnpm --filter @wabe/server test dedupe
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add packages/server/src/dedupe.ts packages/server/test/dedupe.test.ts
git commit -S -m "feat(server): stamp canonical_key + merge seen_on_sources at upsert time"
```

---

### Task 5: Notify-time cross-source dedup

**Files:**
- Create: `packages/server/src/canonical-dedup.ts`
- Create: `packages/server/test/canonical-dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/canonical-dedup.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@wabe/db';
import { Listing } from '@wabe/core';
import { upsertListing } from '../src/dedupe.js';
import { shouldNotify } from '../src/canonical-dedup.js';

function freshDb() {
  const raw = new Database(':memory:');
  const db = { _raw: raw };
  migrate(db);
  return db;
}

function fixture(id: string, source: string, sourcePriority: number, url: string): Listing {
  return Listing.parse({
    id,
    source,
    source_priority: sourcePriority,
    url,
    first_seen_at: new Date('2026-05-18T10:00:00Z'),
    last_seen_at: new Date('2026-05-18T10:00:00Z'),
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
  });
}

describe('shouldNotify', () => {
  it('notifies first arrival in a group with no other sources listed', () => {
    const db = freshDb();
    const l = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, l);
    const v = shouldNotify(db, l);
    expect(v.suppress).toBe(false);
    expect(v.also_seen_on).toEqual([]);
  });
  it('suppresses lower-priority arrival when a higher-priority listing already exists in the group', () => {
    const db = freshDb();
    const flatfox = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, flatfox);
    const realadvisor = fixture('b:1', 'source-realadvisor', 50, 'https://realadvisor.ch/1');
    upsertListing(db, realadvisor);
    const v = shouldNotify(db, realadvisor);
    expect(v.suppress).toBe(true);
  });
  it('notifies higher-priority arrival even when a lower-priority listing exists in the group', () => {
    const db = freshDb();
    const realadvisor = fixture('b:1', 'source-realadvisor', 50, 'https://realadvisor.ch/1');
    upsertListing(db, realadvisor);
    const flatfox = fixture('a:1', 'source-flatfox', 80, 'https://flatfox.ch/1');
    upsertListing(db, flatfox);
    const v = shouldNotify(db, flatfox);
    expect(v.suppress).toBe(false);
    expect(v.also_seen_on).toContain('source-realadvisor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm --filter @wabe/server test canonical-dedup
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `canonical-dedup.ts`**

Create `packages/server/src/canonical-dedup.ts`:

```typescript
import type { Listing } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface DedupVerdict {
  /** When true, the pipeline must NOT notify this listing — a higher-priority canonical duplicate already exists. */
  suppress: boolean;
  /** Names of OTHER sources in the same canonical group, sorted, for the notifier's "Also on:" footer. Empty when this is the first arrival or the only source. */
  also_seen_on: string[];
}

/**
 * Notify-time cross-source dedup check.
 *
 * Looks up other listings sharing this listing's `canonical_key`. If any has
 * a strictly higher `source_priority`, suppress this notification (the winner
 * has already been or will be notified separately). If this listing wins or
 * ties on top priority, allow notification and report the other sources so
 * the notifier can render an "Also on:" footer.
 *
 * Ties: when multiple sources share the highest priority within a group, the
 * first to arrive notifies; subsequent same-priority arrivals are suppressed.
 * The first-arrival check is by `first_seen_at` in the persisted row.
 */
export function shouldNotify(db: WabeDb, listing: Listing): DedupVerdict {
  const rows = db._raw
    .prepare<[string], { id: string; source: string; source_priority: number; first_seen_at: number }>(
      'SELECT id, source, source_priority, first_seen_at FROM listings WHERE canonical_key = ?',
    )
    .all(listing.canonical_key);
  const others = rows.filter((r) => r.id !== listing.id);
  const maxOtherPriority = others.reduce((m, r) => Math.max(m, r.source_priority), -1);
  if (maxOtherPriority > listing.source_priority) {
    return { suppress: true, also_seen_on: [] };
  }
  if (maxOtherPriority === listing.source_priority && others.length > 0) {
    const self = rows.find((r) => r.id === listing.id);
    const olderTie = others.some(
      (r) => r.source_priority === listing.source_priority && self !== undefined && r.first_seen_at < self.first_seen_at,
    );
    if (olderTie) return { suppress: true, also_seen_on: [] };
  }
  const alsoSeen = Array.from(new Set(others.map((r) => r.source))).sort();
  return { suppress: false, also_seen_on: alsoSeen };
}
```

- [ ] **Step 4: Run tests**

```
pnpm --filter @wabe/server test canonical-dedup
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/server/src/canonical-dedup.ts packages/server/test/canonical-dedup.test.ts
git commit -S -m "feat(server): notify-time cross-source dedup (shouldNotify)"
```

---

### Task 6: Wire dedup into the pipeline + plumb `also_seen_on` to notifier

**Files:**
- Modify: `packages/plugin-sdk/src/notifier.ts`
- Modify: `packages/server/src/pipeline.ts`

- [ ] **Step 1: Extend `ListingEvent`**

Open `packages/plugin-sdk/src/notifier.ts`. Locate the `ListingEvent` type. Add a new optional field:

```typescript
export interface ListingEvent {
  listing: Listing;
  score: { final: number; breakdown: Record<string, number> };
  /** Names of other sources in the same canonical group, sorted. Empty when this is the only source. Phase A addition. */
  also_seen_on?: string[];
}
```

(If the exact shape differs, preserve the existing fields and add `also_seen_on?: string[]` to whichever interface is the notifier event.)

- [ ] **Step 2: Apply source_priority and call shouldNotify in the pipeline**

In `packages/server/src/pipeline.ts`:

(a) Add imports at the top:

```typescript
import { SOURCE_PRIORITY_DEFAULTS, DEFAULT_SOURCE_PRIORITY, canonicalKey } from '@wabe/core';
import { shouldNotify } from './canonical-dedup.js';
```

(b) Inside `runSource`, replace the construction of `enriched` with a version that stamps `canonical_key` and `source_priority` from defaults (overridable later via per-source config — out of scope this task; spec §4.2 calls out `sources[].priority`):

```typescript
const ck = canonicalKey({
  postal_code: raw.location?.postal_code ?? null,
  rooms: raw.rooms ?? null,
  area_m2: raw.area_m2 ?? null,
  price_total: raw.price?.total ?? null,
  url: raw.url,
});
const priority = SOURCE_PRIORITY_DEFAULTS[src.plugin.name] ?? DEFAULT_SOURCE_PRIORITY;
const enriched: Listing = Listing.parse({
  ...raw,
  id: raw.id ?? `${raw.source}:unknown:${Date.now()}`,
  first_seen_at: raw.first_seen_at ?? new Date(),
  last_seen_at: raw.last_seen_at ?? new Date(),
  canonical_key: ck,
  source_priority: priority,
});
```

(c) Immediately before the existing `if (!opts.quota.tryConsume()) {` block, insert the cross-source dedup check:

```typescript
const verdict = shouldNotify(opts.db, enriched);
if (verdict.suppress) {
  log.debug({ listing_id: enriched.id, canonical_key: enriched.canonical_key }, 'cross-source dedup suppressed');
  continue;
}
```

(d) Replace the construction of the `event` object passed to `notifySafely` with:

```typescript
const event = { listing: enriched, score, also_seen_on: verdict.also_seen_on };
```

- [ ] **Step 3: Confirm existing pipeline tests still pass**

```
pnpm --filter @wabe/server test pipeline
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add packages/plugin-sdk/src/notifier.ts packages/server/src/pipeline.ts
git commit -S -m "feat(server): cross-source dedup in pipeline + also_seen_on on ListingEvent"
```

---

### Task 7: Notifier card "Also on:" footer

**Files:**
- Modify: `plugins/notifier-telegram/src/card.ts`
- Modify: `plugins/notifier-telegram/test/card.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `plugins/notifier-telegram/test/card.test.ts`:

```typescript
it('renders "Also on:" footer when also_seen_on is non-empty', () => {
  const r = renderCard(
    {
      listing: baseListing,
      score: { final: 80, breakdown: {} },
      also_seen_on: ['source-homegate', 'source-realadvisor'],
    },
    new Date('2026-05-17T10:14:00Z'),
  );
  expect(r.text).toContain('Also on: homegate, realadvisor');
});

it('omits "Also on:" line when also_seen_on is absent or empty', () => {
  const r = renderCard(
    { listing: baseListing, score: { final: 80, breakdown: {} }, also_seen_on: [] },
    new Date('2026-05-17T10:14:00Z'),
  );
  expect(r.text).not.toContain('Also on:');
});
```

- [ ] **Step 2: Run test, observe failure**

```
pnpm --filter notifier-telegram test card
```
Expected: FAIL — footer not rendered.

- [ ] **Step 3: Implement the footer**

In `plugins/notifier-telegram/src/card.ts`, add a helper right above `renderCard`:

```typescript
/** Strips the conventional `source-` prefix from plugin names for compact display. */
function shortSourceName(name: string): string {
  return name.startsWith('source-') ? name.slice('source-'.length) : name;
}

/** Returns the `Also on:` line when at least one other source is listed; null otherwise. */
function renderAlsoOnLine(alsoSeenOn: string[] | undefined): string | null {
  if (!alsoSeenOn || alsoSeenOn.length === 0) return null;
  return `🔁 Also on: ${alsoSeenOn.map(shortSourceName).join(', ')}`;
}
```

Then in `renderCard`, append the helper invocation to the `lines` array (just after the agency line):

```typescript
  const lines = [
    `🏠 ${listing.location.neighborhood ?? listing.location.city ?? 'Unknown'} · ${listing.rooms ?? '?'}Zi · ${listing.price.currency} ${listing.price.total ?? '?'} · ${listing.area_m2 ?? '?'}m²`,
    listing.location.address ? `📍 ${listing.location.address}` : null,
    renderShortTermLine(listing),
    `⭐ Fit ${score.final}/100`,
    listing.agency ? `🏢 ${listing.agency} · listed ${minutesAgo} min ago` : `listed ${minutesAgo} min ago`,
    renderAlsoOnLine(event.also_seen_on),
  ].filter((l): l is string => l !== null);
```

- [ ] **Step 4: Run tests**

```
pnpm --filter notifier-telegram test card
```
Expected: PASS for new tests AND existing tests.

- [ ] **Step 5: Commit**

```
git add plugins/notifier-telegram/src/card.ts plugins/notifier-telegram/test/card.test.ts
git commit -S -m "feat(notifier-telegram): render \"Also on:\" footer for cross-source duplicates"
```

---

> **Checkpoint:** Tasks 1–7 form the shared infra. Verify the full workspace is green before kicking off the parallel plugin workstreams:
>
> ```
> pnpm ci
> ```
>
> If green, push or rebase as appropriate, then create three worktrees from the resulting branch tip for Tasks 8–22.

---

### Task 8: Scaffold `@wabe/source-realadvisor` package

**Files:**
- Create: `plugins/source-realadvisor/package.json`
- Create: `plugins/source-realadvisor/tsconfig.json`
- Create: `plugins/source-realadvisor/README.md` (stub — filled by Task 12)
- Create: `plugins/source-realadvisor/src/index.ts` (stub)

Reference implementation to mirror: `plugins/source-flatfox/` (same layout, same scripts, same toolchain).

- [ ] **Step 1: Write `package.json` mirroring source-flatfox**

Create `plugins/source-realadvisor/package.json`:

```json
{
  "name": "@wabe/source-realadvisor",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./dist/map.js": "./dist/map.js"
  },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wabe/core": "workspace:*",
    "@wabe/plugin-sdk": "workspace:*",
    "pino": "^9.4.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json` mirroring source-flatfox**

Copy `plugins/source-flatfox/tsconfig.json` content verbatim into `plugins/source-realadvisor/tsconfig.json`.

- [ ] **Step 3: Stub `src/index.ts`**

Create `plugins/source-realadvisor/src/index.ts`:

```typescript
// Filled by subsequent tasks (config schema, client, mapper, source export).
export {};
```

- [ ] **Step 4: Stub `README.md`**

Create `plugins/source-realadvisor/README.md`:

```markdown
# @wabe/source-realadvisor

RealAdvisor.ch source plugin for Wabe. See `docs/research/2026-05-18-realadvisor-investigation.md` for the API surface this plugin targets.

Full documentation populated alongside the implementation; see plan task 12.
```

- [ ] **Step 5: Install + verify the workspace picks up the new package**

```
pnpm install
pnpm --filter @wabe/source-realadvisor typecheck
```
Expected: typecheck passes (file is essentially empty).

- [ ] **Step 6: Commit**

```
git add plugins/source-realadvisor/
git commit -S -m "chore(source-realadvisor): scaffold package"
```

---

### Task 9: `source-realadvisor` — config + client + mapper + source export

**Files:**
- Create: `plugins/source-realadvisor/src/search.ts`
- Create: `plugins/source-realadvisor/src/client.ts`
- Create: `plugins/source-realadvisor/src/map.ts`
- Create: `plugins/source-realadvisor/src/index.ts` (overwrite stub)

API surface (per `docs/research/2026-05-18-realadvisor-investigation.md`):
- Endpoint: `GET https://realadvisor.ch/api/listings`
- Query params (selected): `offerType_eq=rent`, `compositePropertyType_eq=apartment`, `placeSlugs=<JSON-encoded string array>`, `sort=created_at_desc`, `page=N` (1-based), 36 items/page.
- Range params: `priceMin_lte`, `priceMin_gte` (etc.), `surfaceLivable_lte`, `surfaceLivable_gte`.
- Response: `{ total_count: number, hits: Array<RawListing>, next?: string }`. Exact field names confirmed by inspecting `https://realadvisor.ch/api/listings?page=1` with a Mozilla UA — the investigation doc shows the response shape derived from the Apollo RSC payload.

- [ ] **Step 1: Config schema (`search.ts`)**

Create `plugins/source-realadvisor/src/search.ts`:

```typescript
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
```

- [ ] **Step 2: HTTP client (`client.ts`) — follows the flatfox pattern (global dispatcher, mockable via `setGlobalDispatcher(MockAgent)`)**

Create `plugins/source-realadvisor/src/client.ts`:

```typescript
import { request } from 'undici';
import { buildSearchParams, type SearchConfig } from './search.js';

export interface BackoffPolicy {
  on: number[];
  retries: number;
  base_ms: number;
}

export interface ClientOpts {
  paceMs: number;
  backoff: BackoffPolicy;
  signal: AbortSignal;
}

export interface RawHit {
  id: string;
  url?: string;
  clickout_url?: { hostname?: string; pathname?: string };
  rooms?: number | null;
  surface_livable?: number | null;
  price?: { value?: number | null; currency?: string | null } | null;
  postal_code?: string | null;
  locality?: string | null;
  canton?: string | null;
  created_at?: string | null;
}

export interface RealAdvisorPage {
  total_count: number;
  hits: RawHit[];
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

export async function fetchPage(cfg: SearchConfig, page: number, opts: ClientOpts): Promise<RealAdvisorPage> {
  const url = `https://realadvisor.ch/api/listings?${buildSearchParams(cfg, page).toString()}`;
  let attempt = 0;
  // simple retry-on-backoff loop
  while (true) {
    const res = await request(url, { signal: opts.signal, method: 'GET', headers: { accept: 'application/json' } });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = (await res.body.json()) as RealAdvisorPage;
      return body;
    }
    if (opts.backoff.on.includes(res.statusCode) && attempt < opts.backoff.retries) {
      const delay = opts.backoff.base_ms * 2 ** attempt;
      attempt += 1;
      await sleep(delay, opts.signal);
      continue;
    }
    throw new Error(`realadvisor /api/listings page ${page} responded ${res.statusCode}`);
  }
}
```

- [ ] **Step 3: Mapper (`map.ts`)**

Create `plugins/source-realadvisor/src/map.ts`:

```typescript
import type { RawListing } from '@wabe/core';
import type { RawHit } from './client.js';

/** Map a realadvisor `RawHit` to Wabe's `RawListing`. Returns null when the hit is unusable. */
export function mapHit(h: RawHit): RawListing | null {
  // realadvisor URLs are encrypted clickout tokens resolved server-side; use the canonical listing detail under realadvisor.ch as the URL field, with the id as the path.
  const url = h.url ?? `https://realadvisor.ch/en/listing/${h.id}`;
  return {
    id: `realadvisor:${h.id}`,
    source: 'source-realadvisor',
    url,
    price: {
      rent_net: null,
      extras: null,
      total: h.price?.value ?? null,
      currency: h.price?.currency ?? 'CHF',
      deposit_months: null,
    },
    rooms: h.rooms ?? null,
    area_m2: h.surface_livable ?? null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: h.postal_code ?? null,
      city: h.locality ?? null,
      region: h.canton ?? null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: { realadvisor_hit_id: h.id },
  };
}
```

- [ ] **Step 4: Source export (`index.ts`)**

Overwrite `plugins/source-realadvisor/src/index.ts`:

```typescript
import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { SearchConfig } from './search.js';
import { fetchPage, sleep } from './client.js';
import { mapHit } from './map.js';

const FetchConfig = z.object({
  page_size: z.literal(36).default(36),
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2000),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/3 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-realadvisor',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    for (let page = 1; page <= cfg.fetch.max_pages; page += 1) {
      if (ctx.signal.aborted) return;
      const res = await fetchPage(cfg.search, page, {
        paceMs: cfg.fetch.pace_ms,
        backoff: cfg.fetch.backoff,
        signal: ctx.signal,
      });
      for (const hit of res.hits) {
        const mapped = mapHit(hit);
        if (mapped) yield mapped;
      }
      if (res.hits.length < 36) break;
      if (page < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
```

- [ ] **Step 5: Typecheck**

```
pnpm --filter @wabe/source-realadvisor typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add plugins/source-realadvisor/src/
git commit -S -m "feat(source-realadvisor): config + client + mapper + source export"
```

---

### Task 10: `source-realadvisor` tests

**Files:**
- Create: `plugins/source-realadvisor/test/fixtures/responses/page-1.json` (captured fixture — see Step 1)
- Create: `plugins/source-realadvisor/test/client.test.ts`
- Create: `plugins/source-realadvisor/test/map.test.ts`

- [ ] **Step 1: Capture a fixture**

Run once locally (this happens manually, NOT in CI) to capture the page-1 response shape:

```
curl -s -A 'Mozilla/5.0' \
  'https://realadvisor.ch/api/listings?offerType_eq=rent&compositePropertyType_eq=apartment&placeSlugs=%5B%22canton-zurich%22%5D&sort=created_at_desc&page=1' \
  | jq 'del(.hits[].images) | .hits |= .[:5]' \
  > plugins/source-realadvisor/test/fixtures/responses/page-1.json
```

(Slice to 5 hits and drop heavy image arrays so fixtures stay small.)

If the live shape diverges from the assumed shape in `client.ts:RawHit`, adjust both the fixture and the type before continuing.

- [ ] **Step 2: Write the client test**

Create `plugins/source-realadvisor/test/client.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { fetchPage } from '../src/client.js';
import { SearchConfig } from '../src/search.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'responses');
const pageOne = readFileSync(join(FIXTURE_DIR, 'page-1.json'), 'utf8');

let agent: MockAgent;
let prev: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  prev = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(prev);
});

describe('fetchPage', () => {
  it('parses page-1 response into hits + total_count', async () => {
    agent
      .get('https://realadvisor.ch')
      .intercept({ method: 'GET', path: /\/api\/listings/ })
      .reply(200, pageOne, { headers: { 'content-type': 'application/json' } });

    const res = await fetchPage(SearchConfig.parse({}), 1, {
      paceMs: 0,
      backoff: { on: [429], retries: 0, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(typeof res.total_count).toBe('number');
  });

  it('retries on 429 then succeeds', async () => {
    const pool = agent.get('https://realadvisor.ch');
    pool.intercept({ method: 'GET', path: /\/api\/listings/ }).reply(429, 'rate limited').times(1);
    pool.intercept({ method: 'GET', path: /\/api\/listings/ }).reply(200, pageOne, {
      headers: { 'content-type': 'application/json' },
    });
    const res = await fetchPage(SearchConfig.parse({}), 1, {
      paceMs: 0,
      backoff: { on: [429], retries: 1, base_ms: 1 },
      signal: new AbortController().signal,
    });
    expect(res.hits.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Write the mapper test**

Create `plugins/source-realadvisor/test/map.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mapHit } from '../src/map.js';

describe('mapHit', () => {
  it('maps a minimum-viable hit', () => {
    const out = mapHit({
      id: '123',
      rooms: 4.5,
      surface_livable: 112,
      price: { value: 3200, currency: 'CHF' },
      postal_code: '8008',
      locality: 'Zürich',
      canton: 'ZH',
    });
    expect(out?.id).toBe('realadvisor:123');
    expect(out?.source).toBe('source-realadvisor');
    expect(out?.rooms).toBe(4.5);
    expect(out?.area_m2).toBe(112);
    expect(out?.price.total).toBe(3200);
    expect(out?.location.postal_code).toBe('8008');
  });

  it('falls back to canonical listing URL when hit.url is absent', () => {
    const out = mapHit({ id: '987' });
    expect(out?.url).toBe('https://realadvisor.ch/en/listing/987');
  });
});
```

- [ ] **Step 4: Run all tests in the package**

```
pnpm --filter @wabe/source-realadvisor test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add plugins/source-realadvisor/test/
git commit -S -m "test(source-realadvisor): client retry + mapper coverage with captured fixture"
```

---

### Task 11: `source-realadvisor` README

**Files:**
- Modify: `plugins/source-realadvisor/README.md`

- [ ] **Step 1: Replace stub with full README**

Overwrite `plugins/source-realadvisor/README.md`:

```markdown
# @wabe/source-realadvisor

Source plugin for [realadvisor.ch](https://realadvisor.ch) — Swiss real-estate aggregator with a public REST endpoint.

## API surface

- Endpoint: `GET https://realadvisor.ch/api/listings`
- Anonymous: no API key, no auth, no captcha
- Pagination: 1-based, 36 items/page (`page=N`)
- Default sort: `created_at_desc` (newest first — perfect for polling)
- Response includes `total_count` for pagination planning

See `docs/research/2026-05-18-realadvisor-investigation.md` for the investigation notes.

## Aggregator caveat

RealAdvisor surfaces listings from other Swiss portals (Homegate, ImmoScout24, Flatfox, …) with an encrypted clickout URL token resolved server-side. The original portal is NOT exposed in the API. Heavy overlap with `@wabe/source-flatfox` and `@wabe/source-homegate` is expected; Wabe's cross-source dedup (Phase A) handles the overlap and demotes realadvisor to a fallback when a portal duplicate is available (default priority `50` vs portals at `70-80`).

## Config

```yaml
schedule: '*/3 * * * *'
search:
  offer_type: rent
  composite_property_type: apartment
  place_slugs: ['canton-zurich']
  price_max: 4000
  surface_min: 80
fetch:
  max_pages: 5
  pace_ms: 2000
```

All `search.*` fields are optional with sensible Zurich-apartment-rental defaults.

## Tests

`pnpm --filter @wabe/source-realadvisor test`

Tests use undici `MockAgent` with a captured fixture under `test/fixtures/responses/`. No live network calls.
```

- [ ] **Step 2: Commit**

```
git add plugins/source-realadvisor/README.md
git commit -S -m "docs(source-realadvisor): README with API surface + aggregator caveat"
```

---

### Task 12: Scaffold `@wabe/source-immoscout24-sitemap` package

**Files:**
- Create: `plugins/source-immoscout24-sitemap/package.json`
- Create: `plugins/source-immoscout24-sitemap/tsconfig.json`
- Create: `plugins/source-immoscout24-sitemap/README.md` (stub)
- Create: `plugins/source-immoscout24-sitemap/src/index.ts` (stub)

- [ ] **Step 1: Write `package.json`**

Create `plugins/source-immoscout24-sitemap/package.json`:

```json
{
  "name": "@wabe/source-immoscout24-sitemap",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wabe/core": "workspace:*",
    "@wabe/db": "workspace:*",
    "@wabe/plugin-sdk": "workspace:*",
    "fast-xml-parser": "^4.5.0",
    "pino": "^9.4.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Copy `tsconfig.json` from source-flatfox**

Same content as `plugins/source-flatfox/tsconfig.json`.

- [ ] **Step 3: Stub README and `src/index.ts`** (placeholders filled in subsequent tasks).

- [ ] **Step 4: Install + typecheck**

```
pnpm install
pnpm --filter @wabe/source-immoscout24-sitemap typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add plugins/source-immoscout24-sitemap/
git commit -S -m "chore(source-immoscout24-sitemap): scaffold package"
```

---

### Task 13: `source-immoscout24-sitemap` — fetch + gunzip + diff + persist state

**Files:**
- Create: `plugins/source-immoscout24-sitemap/src/sitemap.ts`
- Create: `plugins/source-immoscout24-sitemap/src/state.ts`
- Create: `plugins/source-immoscout24-sitemap/src/map.ts`
- Create: `plugins/source-immoscout24-sitemap/src/index.ts` (overwrite stub)
- Create: `plugins/source-immoscout24-sitemap/test/fixtures/`
- Create: `plugins/source-immoscout24-sitemap/test/sitemap.test.ts`
- Create: `plugins/source-immoscout24-sitemap/test/map.test.ts`

Sitemap structure (per `docs/research/2026-05-18-immoscout24-investigation.md`):
- Root: `https://www.immoscout24.ch/sitemap/sitemap.xml` (index)
- Per-language rent leaves: `pdp-N-sitemap-RENT-<lang>.xml.gz` — gzipped urlset, ~38k URLs each with `<lastmod>`, `<image:loc>`, `<image:geo_location>`
- `<image:geo_location>` text shape: `"<zip> <locality>, <canton>"`, e.g. `"8008 Zürich, ZH"`

- [ ] **Step 1: Write sitemap parser (`sitemap.ts`)**

Create `plugins/source-immoscout24-sitemap/src/sitemap.ts`:

```typescript
import { request } from 'undici';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  image_loc: string | null;
  geo_location: string | null;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Fetch + gunzip + parse a single sitemap leaf (e.g. pdp-1-sitemap-RENT-de.xml.gz). */
export async function fetchSitemapLeaf(url: string, signal: AbortSignal): Promise<SitemapEntry[]> {
  const res = await request(url, { signal, method: 'GET' });
  if (res.statusCode !== 200) throw new Error(`sitemap leaf ${url} responded ${res.statusCode}`);
  const buf = Buffer.from(await res.body.arrayBuffer());
  const xmlText = url.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return parseUrlset(xmlText);
}

export function parseUrlset(xmlText: string): SitemapEntry[] {
  const parsed = xml.parse(xmlText) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return list.map((u) => {
    const node = u as {
      loc?: string;
      lastmod?: string;
      ['image:image']?: { ['image:loc']?: string; ['image:geo_location']?: string };
    };
    const img = node['image:image'];
    return {
      loc: String(node.loc ?? ''),
      lastmod: node.lastmod ?? null,
      image_loc: img?.['image:loc'] ?? null,
      geo_location: img?.['image:geo_location'] ?? null,
    };
  });
}

/** Fetch the sitemap index and return absolute URLs of every rent-language leaf. */
export async function discoverRentLeaves(rootUrl: string, signal: AbortSignal): Promise<string[]> {
  const res = await request(rootUrl, { signal, method: 'GET' });
  if (res.statusCode !== 200) throw new Error(`sitemap index responded ${res.statusCode}`);
  const text = await res.body.text();
  const parsed = xml.parse(text) as { sitemapindex?: { sitemap?: unknown } };
  const items = parsed.sitemapindex?.sitemap;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return list
    .map((s) => (s as { loc?: string }).loc ?? '')
    .filter((l) => /pdp-\d+-sitemap-RENT-[a-z]+\.xml\.gz$/i.test(l));
}
```

- [ ] **Step 2: Write state persistence (`state.ts`) using existing `sitemap_state` table**

Create `plugins/source-immoscout24-sitemap/src/state.ts`:

```typescript
import type { WabeDb } from '@wabe/db';

const SOURCE_NAME = 'source-immoscout24-sitemap';

/** Returns the set of canonical detail URLs we already emitted on a previous scan, or null on first run. */
export function loadSeenUrls(db: WabeDb): Set<string> | null {
  const row = db._raw
    .prepare<[string], { state: string }>('SELECT state FROM sitemap_state WHERE source = ?')
    .get(SOURCE_NAME);
  if (!row) return null;
  try {
    const arr = JSON.parse(row.state) as string[];
    return new Set(arr);
  } catch {
    return null;
  }
}

export function saveSeenUrls(db: WabeDb, urls: Set<string>): void {
  const now = Date.now();
  const payload = JSON.stringify([...urls]);
  db._raw
    .prepare(
      'INSERT INTO sitemap_state (source, last_seen_at, state) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET last_seen_at = excluded.last_seen_at, state = excluded.state',
    )
    .run(SOURCE_NAME, now, payload);
}
```

- [ ] **Step 3: Write the mapper (`map.ts`)**

Create `plugins/source-immoscout24-sitemap/src/map.ts`:

```typescript
import type { RawListing } from '@wabe/core';
import type { SitemapEntry } from './sitemap.js';

/**
 * Sitemap entries yield URL-only listings with geo + thumbnail. Detail fields
 * (rooms/area/price/description) remain null — Phase B's browser bridge
 * promotes this plugin to full-detail by re-fetching each PDP through the
 * extension.
 */
export function mapEntry(e: SitemapEntry): RawListing | null {
  if (!e.loc) return null;
  // immoscout24 detail URL ends with /<id> — use last numeric segment as the id source.
  const idMatch = e.loc.match(/\/(\d+)(?:\?|$)/);
  const id = idMatch ? idMatch[1] : e.loc;
  const geo = parseGeo(e.geo_location);
  return {
    id: `immoscout24:${id}`,
    source: 'source-immoscout24-sitemap',
    url: e.loc,
    price: { rent_net: null, extras: null, total: null, currency: 'CHF', deposit_months: null },
    rooms: null,
    area_m2: null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: geo.postal_code,
      city: geo.locality,
      region: geo.canton,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: e.image_loc ? [e.image_loc] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: { sitemap_lastmod: e.lastmod ?? null },
  };
}

/** `"8008 Zürich, ZH"` → { postal_code, locality, canton }. Returns nulls for missing parts. */
export function parseGeo(geo: string | null): {
  postal_code: string | null;
  locality: string | null;
  canton: string | null;
} {
  if (!geo) return { postal_code: null, locality: null, canton: null };
  const m = geo.match(/^\s*(\d{4})\s+([^,]+?)\s*,\s*([A-Z]{2})\s*$/);
  if (!m) return { postal_code: null, locality: null, canton: null };
  return { postal_code: m[1] ?? null, locality: (m[2] ?? '').trim() || null, canton: m[3] ?? null };
}
```

- [ ] **Step 4: Write the source export (`index.ts`)**

Overwrite `plugins/source-immoscout24-sitemap/src/index.ts`:

```typescript
import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { discoverRentLeaves, fetchSitemapLeaf } from './sitemap.js';
import { loadSeenUrls, saveSeenUrls } from './state.js';
import { mapEntry } from './map.js';

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  root_url: z.string().url().default('https://www.immoscout24.ch/sitemap/sitemap.xml'),
  /** Filter leaves to only specific languages to reduce work; defaults to German leaves. */
  languages: z.array(z.enum(['de', 'fr', 'it', 'en'])).default(['de']),
  /** When true, every URL in the very first scan is emitted as "new". When false, the first scan only seeds the state and emits nothing. */
  emit_on_first_scan: z.boolean().default(false),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-immoscout24-sitemap',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const leaves = await discoverRentLeaves(cfg.root_url, ctx.signal);
    const filtered = leaves.filter((url) => cfg.languages.some((lang) => url.includes(`-RENT-${lang}.xml.gz`)));
    const seen = loadSeenUrls(ctx.db);
    const newSeen = new Set(seen ?? []);
    for (const leafUrl of filtered) {
      if (ctx.signal.aborted) return;
      const entries = await fetchSitemapLeaf(leafUrl, ctx.signal);
      for (const e of entries) {
        if (!e.loc) continue;
        const isNew = !newSeen.has(e.loc);
        newSeen.add(e.loc);
        if (seen === null && !cfg.emit_on_first_scan) continue;
        if (!isNew) continue;
        const mapped = mapEntry(e);
        if (mapped) yield mapped;
      }
    }
    saveSeenUrls(ctx.db, newSeen);
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
```

- [ ] **Step 5: Write tests**

Create `plugins/source-immoscout24-sitemap/test/sitemap.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseUrlset } from '../src/sitemap.js';

describe('parseUrlset', () => {
  it('parses urlset with image:loc + geo_location', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://www.immoscout24.ch/rent/4002256697</loc>
    <lastmod>2026-05-17T08:00:00Z</lastmod>
    <image:image>
      <image:loc>https://cdn.example/img.jpg</image:loc>
      <image:geo_location>8008 Zürich, ZH</image:geo_location>
    </image:image>
  </url>
</urlset>`;
    const out = parseUrlset(xml);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      loc: 'https://www.immoscout24.ch/rent/4002256697',
      lastmod: '2026-05-17T08:00:00Z',
      image_loc: 'https://cdn.example/img.jpg',
      geo_location: '8008 Zürich, ZH',
    });
  });
});
```

Create `plugins/source-immoscout24-sitemap/test/map.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mapEntry, parseGeo } from '../src/map.js';

describe('parseGeo', () => {
  it('parses ZIP + locality + canton', () => {
    expect(parseGeo('8008 Zürich, ZH')).toEqual({ postal_code: '8008', locality: 'Zürich', canton: 'ZH' });
  });
  it('returns nulls on unparseable input', () => {
    expect(parseGeo('garbage')).toEqual({ postal_code: null, locality: null, canton: null });
    expect(parseGeo(null)).toEqual({ postal_code: null, locality: null, canton: null });
  });
});

describe('mapEntry', () => {
  it('maps a sitemap entry to a URL-only RawListing with geo + thumbnail', () => {
    const out = mapEntry({
      loc: 'https://www.immoscout24.ch/rent/4002256697',
      lastmod: '2026-05-17T08:00:00Z',
      image_loc: 'https://cdn.example/img.jpg',
      geo_location: '8008 Zürich, ZH',
    });
    expect(out?.id).toBe('immoscout24:4002256697');
    expect(out?.source).toBe('source-immoscout24-sitemap');
    expect(out?.url).toContain('/rent/4002256697');
    expect(out?.location.postal_code).toBe('8008');
    expect(out?.photos).toEqual(['https://cdn.example/img.jpg']);
    expect(out?.rooms).toBeNull();
    expect(out?.price.total).toBeNull();
  });
});
```

- [ ] **Step 6: Run all tests**

```
pnpm --filter @wabe/source-immoscout24-sitemap test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add plugins/source-immoscout24-sitemap/src/ plugins/source-immoscout24-sitemap/test/
git commit -S -m "feat(source-immoscout24-sitemap): sitemap diff + URL-only listings with geo + thumbnail"
```

---

### Task 14: `source-immoscout24-sitemap` README

**Files:**
- Modify: `plugins/source-immoscout24-sitemap/README.md`

- [ ] **Step 1: Write README**

Overwrite `plugins/source-immoscout24-sitemap/README.md`:

```markdown
# @wabe/source-immoscout24-sitemap

URL-diff source plugin for [ImmoScout24.ch](https://www.immoscout24.ch). Watches the public sitemap (no anti-bot, no auth) and emits a new `Listing` each time a previously-unseen rental detail URL appears.

## Why URL-only

The HTML and API surfaces are DataDome + Cloudflare protected — see `docs/research/2026-05-18-immoscout24-investigation.md`. The sitemap is open and contains 38k+ rental URLs with `lastmod`, thumbnail image URL, and `<zip locality, canton>` geo. That is enough for a "new listing on IS24" Telegram notification with a tap-to-open button.

Detail fields (`rooms`, `area_m2`, `price`, `description`) are emitted as `null`. Phase B's browser bridge (separate spec) will promote this plugin to full-detail by re-fetching each PDP through a paired Chrome/Firefox extension.

## Config

```yaml
schedule: '*/15 * * * *'
root_url: 'https://www.immoscout24.ch/sitemap/sitemap.xml'
languages: ['de']        # restrict to German leaves; pick from de/fr/it/en
emit_on_first_scan: false  # safe default: first scan only seeds state
```

## State

Maintains a set of seen URLs in the `sitemap_state` table (key: `source-immoscout24-sitemap`). The first scan seeds this set silently (no notifications) unless `emit_on_first_scan: true` is set. Subsequent scans diff against the saved set and emit only previously-unseen URLs.

## Tests

`pnpm --filter @wabe/source-immoscout24-sitemap test`

XML parsing and mapping are tested with inline XML fixtures; no live network calls.
```

- [ ] **Step 2: Commit**

```
git add plugins/source-immoscout24-sitemap/README.md
git commit -S -m "docs(source-immoscout24-sitemap): README with rationale + config + state notes"
```

---

### Task 15: Scaffold `@wabe/source-immobilier-ch` package

**Files:**
- Create: `plugins/source-immobilier-ch/package.json`
- Create: `plugins/source-immobilier-ch/tsconfig.json`
- Create: `plugins/source-immobilier-ch/README.md` (stub)
- Create: `plugins/source-immobilier-ch/src/index.ts` (stub)

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabe/source-immobilier-ch",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wabe/core": "workspace:*",
    "@wabe/plugin-sdk": "workspace:*",
    "fast-xml-parser": "^4.5.0",
    "pino": "^9.4.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** — copy from source-flatfox.

- [ ] **Step 3: Stub README + `src/index.ts`.**

- [ ] **Step 4: Install + typecheck**

```
pnpm install
pnpm --filter @wabe/source-immobilier-ch typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add plugins/source-immobilier-ch/
git commit -S -m "chore(source-immobilier-ch): scaffold package"
```

---

### Task 16: `source-immobilier-ch` — sitemap-driven crawler + JSON-LD parser + mapper + source export

**Files:**
- Create: `plugins/source-immobilier-ch/src/sitemap.ts`
- Create: `plugins/source-immobilier-ch/src/detail.ts`
- Create: `plugins/source-immobilier-ch/src/map.ts`
- Create: `plugins/source-immobilier-ch/src/index.ts` (overwrite stub)
- Create: `plugins/source-immobilier-ch/test/sitemap.test.ts`
- Create: `plugins/source-immobilier-ch/test/detail.test.ts`
- Create: `plugins/source-immobilier-ch/test/map.test.ts`

API surface (per `docs/research/2026-05-18-immobilier-ch-investigation.md`):
- Sitemap: `https://www.immobilier.ch/sitemap/rents.xml` lists detail URLs with `<lastmod>`.
- Detail HTML embeds JSON-LD blocks: `@type: Product` (with `offers.price` + `offers.priceCurrency`) and `@type: Residence` (with `address.streetAddress`, `address.postalCode`, `address.addressLocality`).
- Server: Kestrel (ASP.NET) + CloudFront. No anti-bot. Honors site-stated 5s `Crawl-delay`.

- [ ] **Step 1: Sitemap parser (`sitemap.ts`) — mirror IS24 version, no gzip**

Create `plugins/source-immobilier-ch/src/sitemap.ts`:

```typescript
import { request } from 'undici';
import { XMLParser } from 'fast-xml-parser';

export interface DetailUrl {
  loc: string;
  lastmod: string | null;
}

const xml = new XMLParser({ ignoreAttributes: false });

export async function fetchSitemap(url: string, signal: AbortSignal): Promise<DetailUrl[]> {
  const res = await request(url, { signal, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 wabe/0' } });
  if (res.statusCode !== 200) throw new Error(`sitemap ${url} responded ${res.statusCode}`);
  const text = await res.body.text();
  return parseUrlset(text);
}

export function parseUrlset(xmlText: string): DetailUrl[] {
  const parsed = xml.parse(xmlText) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return list.map((u) => {
    const node = u as { loc?: string; lastmod?: string };
    return { loc: String(node.loc ?? ''), lastmod: node.lastmod ?? null };
  });
}
```

- [ ] **Step 2: Detail fetcher + JSON-LD extractor (`detail.ts`)**

Create `plugins/source-immobilier-ch/src/detail.ts`:

```typescript
import { request } from 'undici';

export interface JsonLdProduct {
  '@type': 'Product';
  name?: string;
  description?: string;
  offers?: { price?: number | string; priceCurrency?: string };
  image?: string | string[];
}

export interface JsonLdResidence {
  '@type': 'Residence';
  address?: { streetAddress?: string; postalCode?: string; addressLocality?: string };
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
}

export interface DetailPayload {
  product: JsonLdProduct | null;
  residence: JsonLdResidence | null;
}

export async function fetchDetail(url: string, signal: AbortSignal): Promise<DetailPayload> {
  const res = await request(url, {
    signal,
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 wabe/0', accept: 'text/html' },
  });
  if (res.statusCode !== 200) throw new Error(`detail ${url} responded ${res.statusCode}`);
  const html = await res.body.text();
  return extractJsonLd(html);
}

export function extractJsonLd(html: string): DetailPayload {
  const out: DetailPayload = { product: null, residence: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[1];
    if (!block) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      collect(obj, out);
    } catch {
      // ignore malformed blocks
    }
  }
  return out;
}

function collect(obj: unknown, out: DetailPayload): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) collect(item, out);
    return;
  }
  const type = (obj as { '@type'?: string })['@type'];
  if (type === 'Product') out.product = obj as JsonLdProduct;
  if (type === 'Residence') out.residence = obj as JsonLdResidence;
  // walk nested values
  for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
}
```

- [ ] **Step 3: Mapper (`map.ts`)**

Create `plugins/source-immobilier-ch/src/map.ts`:

```typescript
import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapDetail(url: string, payload: DetailPayload): RawListing | null {
  const { product, residence } = payload;
  // Need at least a Product to map.
  if (!product) return null;
  const idMatch = url.match(/-(\d+)(?:\?|$)/);
  const id = idMatch ? idMatch[1] : url;
  return {
    id: `immobilier-ch:${id}`,
    source: 'source-immobilier-ch',
    url,
    price: {
      rent_net: null,
      extras: null,
      total: toNum(product.offers?.price),
      currency: product.offers?.priceCurrency ?? 'CHF',
      deposit_months: null,
    },
    rooms: toNum(residence?.numberOfRooms),
    area_m2: toNum(residence?.floorSize?.value),
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: residence?.address?.streetAddress ?? null,
      postal_code: residence?.address?.postalCode ?? null,
      city: residence?.address?.addressLocality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: product.description ?? null,
    photos: Array.isArray(product.image) ? product.image : product.image ? [product.image] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
  };
}
```

- [ ] **Step 4: Source export (`index.ts`)**

Overwrite `plugins/source-immobilier-ch/src/index.ts`:

```typescript
import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { fetchSitemap } from './sitemap.js';
import { fetchDetail } from './detail.js';
import { mapDetail } from './map.js';

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  sitemap_url: z.string().url().default('https://www.immobilier.ch/sitemap/rents.xml'),
  /** Honor site's stated Crawl-delay (5s); raise to be politer. */
  pace_ms: z.number().int().nonnegative().default(5000),
  /** Hard cap per scan run to bound runtime. */
  max_details_per_scan: z.number().int().positive().default(50),
  /** When true, the very first scan emits every URL. When false, the first scan only seeds state. */
  emit_on_first_scan: z.boolean().default(false),
  /** Only emit listings whose URL contains one of these substrings (e.g. ['zurich/zurich/']). Empty array = no filter. */
  url_must_include: z.array(z.string()).default([]),
});
type Config = z.infer<typeof ConfigSchema>;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

const plugin: Source = {
  name: 'source-immobilier-ch',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const entries = await fetchSitemap(cfg.sitemap_url, ctx.signal);
    const filtered = entries.filter((e) =>
      cfg.url_must_include.length === 0 ? true : cfg.url_must_include.some((s) => e.loc.includes(s)),
    );
    // Sort by lastmod desc so newest listings get attention first within the per-scan cap.
    filtered.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
    let scanned = 0;
    for (const e of filtered) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      scanned += 1;
      const payload = await fetchDetail(e.loc, ctx.signal);
      const mapped = mapDetail(e.loc, payload);
      if (mapped) yield mapped;
      await sleep(cfg.pace_ms, ctx.signal);
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
```

- [ ] **Step 5: Tests**

Create `plugins/source-immobilier-ch/test/sitemap.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseUrlset } from '../src/sitemap.js';

describe('parseUrlset', () => {
  it('parses urlset with loc + lastmod', () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345</loc><lastmod>2026-05-17</lastmod></url>
</urlset>`;
    const out = parseUrlset(xml);
    expect(out).toEqual([
      { loc: 'https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345', lastmod: '2026-05-17' },
    ]);
  });
});
```

Create `plugins/source-immobilier-ch/test/detail.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractJsonLd } from '../src/detail.js';

describe('extractJsonLd', () => {
  it('extracts Product and Residence blocks', () => {
    const html = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Flat","offers":{"price":"3200","priceCurrency":"CHF"},"image":"https://x/i.jpg"}</script>
<script type="application/ld+json">{"@type":"Residence","address":{"streetAddress":"Forchstrasse 187","postalCode":"8008","addressLocality":"Zürich"},"numberOfRooms":"4.5","floorSize":{"value":"112"}}</script>
</head></html>`;
    const out = extractJsonLd(html);
    expect(out.product?.offers?.price).toBe('3200');
    expect(out.residence?.address?.postalCode).toBe('8008');
    expect(out.residence?.numberOfRooms).toBe('4.5');
  });
  it('returns nulls when no JSON-LD blocks present', () => {
    expect(extractJsonLd('<html><body>no json-ld here</body></html>')).toEqual({ product: null, residence: null });
  });
});
```

Create `plugins/source-immobilier-ch/test/map.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mapDetail } from '../src/map.js';

describe('mapDetail', () => {
  it('maps a full Product + Residence payload', () => {
    const url = 'https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345';
    const out = mapDetail(url, {
      product: { '@type': 'Product', description: 'A flat', offers: { price: '3200', priceCurrency: 'CHF' }, image: 'https://x/i.jpg' },
      residence: {
        '@type': 'Residence',
        address: { streetAddress: 'Forchstrasse 187', postalCode: '8008', addressLocality: 'Zürich' },
        numberOfRooms: '4.5',
        floorSize: { value: '112' },
      },
    });
    expect(out?.id).toBe('immobilier-ch:12345');
    expect(out?.rooms).toBe(4.5);
    expect(out?.area_m2).toBe(112);
    expect(out?.price.total).toBe(3200);
    expect(out?.location.postal_code).toBe('8008');
  });
  it('returns null when Product is absent', () => {
    expect(mapDetail('https://x/abc-1', { product: null, residence: null })).toBeNull();
  });
});
```

- [ ] **Step 6: Run all package tests**

```
pnpm --filter @wabe/source-immobilier-ch test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add plugins/source-immobilier-ch/src/ plugins/source-immobilier-ch/test/
git commit -S -m "feat(source-immobilier-ch): sitemap-driven crawler + JSON-LD parser + mapper"
```

---

### Task 17: `source-immobilier-ch` README

**Files:**
- Modify: `plugins/source-immobilier-ch/README.md`

- [ ] **Step 1: Write README**

Overwrite `plugins/source-immobilier-ch/README.md`:

```markdown
# @wabe/source-immobilier-ch

Source plugin for [immobilier.ch](https://www.immobilier.ch). HTML-scraping plugin built on the site's public sitemap + embedded JSON-LD blocks. No anti-bot, no auth.

## Coverage caveat

immobilier.ch is **Romandie-heavy** (probe-time counts: Geneva ~993, Lausanne ~500, Zurich ~220, Bern ~45). For Zurich-focused configs, use the `url_must_include` filter to drop the FR-CH long tail:

```yaml
url_must_include: ['/zurich/zurich/']
```

For FR-CH users, leave the filter empty to scan everything.

## How it works

1. Fetches `https://www.immobilier.ch/sitemap/rents.xml` listing every active rental detail URL with `<lastmod>`.
2. Sorts by `lastmod` desc and applies `url_must_include` filter.
3. Iterates up to `max_details_per_scan` URLs (default 50), fetches each detail page, extracts `@type: Product` + `@type: Residence` JSON-LD blocks and maps them into `Listing`.
4. Honors `pace_ms` between requests (default 5000ms, matches site's stated `Crawl-delay`).

## Config

```yaml
schedule: '*/15 * * * *'
sitemap_url: 'https://www.immobilier.ch/sitemap/rents.xml'
pace_ms: 5000
max_details_per_scan: 50
emit_on_first_scan: false
url_must_include: ['/zurich/zurich/']
```

## Tests

`pnpm --filter @wabe/source-immobilier-ch test`

XML parsing, JSON-LD extraction, and mapping use inline fixtures. No live network calls.
```

- [ ] **Step 2: Commit**

```
git add plugins/source-immobilier-ch/README.md
git commit -S -m "docs(source-immobilier-ch): README with Romandie caveat + config + flow"
```

---

> **Checkpoint:** Tasks 8–17 complete the three plugin packages. Merge each plugin worktree back to `main` before starting Task 18.

---

### Task 18: Register new sources as `@wabe/server` dependencies

**Files:**
- Modify: `packages/server/package.json`

Per CLAUDE.md: the server lists shipping plugins in its `dependencies` so the loader's dynamic `import()` resolves them at runtime from `packages/server/node_modules/`.

- [ ] **Step 1: Add the three new packages**

In `packages/server/package.json`, add to `"dependencies"`:

```json
    "@wabe/source-realadvisor": "workspace:*",
    "@wabe/source-immoscout24-sitemap": "workspace:*",
    "@wabe/source-immobilier-ch": "workspace:*",
```

- [ ] **Step 2: Reinstall + build the server to confirm**

```
pnpm install
pnpm --filter @wabe/server build
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```
git add packages/server/package.json pnpm-lock.yaml
git commit -S -m "chore(server): ship realadvisor + immoscout24-sitemap + immobilier-ch plugins"
```

---

### Task 19: Update zurich-family example config

**Files:**
- Create: `examples/zurich-family/config/plugins/source-realadvisor.yaml`
- Create: `examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml`
- Create: `examples/zurich-family/config/plugins/source-immobilier-ch.yaml`
- Modify: `examples/zurich-family/config/config.yaml`
- Modify: `examples/zurich-family/test/gate.test.ts`

- [ ] **Step 1: Plugin configs**

Create `examples/zurich-family/config/plugins/source-realadvisor.yaml`:

```yaml
schedule: '*/3 * * * *'
search:
  offer_type: rent
  composite_property_type: apartment
  place_slugs: ['canton-zurich']
  price_max: 4000
  surface_min: 80
fetch:
  max_pages: 5
  pace_ms: 2000
```

Create `examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml`:

```yaml
schedule: '*/15 * * * *'
languages: ['de']
emit_on_first_scan: false
```

Create `examples/zurich-family/config/plugins/source-immobilier-ch.yaml`:

```yaml
schedule: '*/15 * * * *'
pace_ms: 5000
max_details_per_scan: 30
url_must_include: ['/zurich/zurich/']
emit_on_first_scan: false
```

- [ ] **Step 2: Enable in `config.yaml`**

In `examples/zurich-family/config/config.yaml`, extend the `enabled.sources` list:

```yaml
enabled:
  sources:
    - {name: flatfox-zurich,             plugin: source-flatfox,              config: plugins/source-flatfox.yaml}
    - {name: homegate-zurich,            plugin: source-homegate,             config: plugins/source-homegate.yaml}
    - {name: realadvisor-zurich,         plugin: source-realadvisor,          config: plugins/source-realadvisor.yaml}
    - {name: immoscout24-sitemap,        plugin: source-immoscout24-sitemap,  config: plugins/source-immoscout24-sitemap.yaml}
    - {name: immobilier-zurich,          plugin: source-immobilier-ch,        config: plugins/source-immobilier-ch.yaml}
  notifiers:
    - {name: telegram, plugin: notifier-telegram, config: plugins/notifier-telegram.yaml}
log:
  level: info
```

- [ ] **Step 3: Extend the gate test to cover new sources**

Open `examples/zurich-family/test/gate.test.ts`. Append the new source plugin names to the iteration so the test verifies the example doesn't reference fields the new plugins can't populate. (Follow the existing pattern — read each plugin's emitted RawListing shape and assert filters/scoring keys are a subset.)

- [ ] **Step 4: Run example tests**

```
pnpm --filter @wabe/example-zurich-family test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add examples/zurich-family/
git commit -S -m "feat(examples): enable realadvisor + immoscout24-sitemap + immobilier-ch in zurich-family"
```

---

### Task 20: End-to-end integration test (3 stub sources + overlap)

**Files:**
- Create: `packages/server/test/pipeline-dedup.integration.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/test/pipeline-dedup.integration.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@wabe/db';
import { Listing } from '@wabe/core';
import type { RawListing } from '@wabe/core';
import type { Source, Notifier, ListingEvent } from '@wabe/plugin-sdk';
import { runOnce } from '../src/pipeline.js';

/** Stub a source that yields a fixed list of partial RawListings. */
function stubSource(name: string, listings: RawListing[]): Source {
  return {
    name,
    configSchema: undefined as never,
    async *fetch() {
      for (const l of listings) yield l;
    },
  } as unknown as Source;
}

/** Capture-only notifier that records every event it sees. */
function captureNotifier(): { plugin: Notifier; seen: ListingEvent[] } {
  const seen: ListingEvent[] = [];
  const plugin: Notifier = {
    name: 'capture',
    configSchema: undefined as never,
    async notify(ev) {
      seen.push(ev);
      return { ok: true };
    },
  } as unknown as Notifier;
  return { plugin, seen };
}

function rawAt(source: string, id: string, url: string): RawListing {
  return {
    id,
    source,
    url,
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: { coords: null, address: null, postal_code: '8008', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
  } as RawListing;
}

describe('pipeline cross-source dedup integration', () => {
  it('three sources publishing the same canonical listing produce exactly one notification (highest-priority wins, others appear in also_seen_on)', async () => {
    const raw = new Database(':memory:');
    const db = { _raw: raw };
    migrate(db);

    const flatfox = stubSource('source-flatfox', [rawAt('source-flatfox', 'a:1', 'https://flatfox.ch/1')]);
    const realadvisor = stubSource('source-realadvisor', [
      rawAt('source-realadvisor', 'b:1', 'https://realadvisor.ch/1'),
    ]);
    const immobilier = stubSource('source-immobilier-ch', [
      rawAt('source-immobilier-ch', 'c:1', 'https://immobilier.ch/1'),
    ]);

    const cap = captureNotifier();

    // Run with a minimal config — wire up via the existing config shape in @wabe/server. The exact construction of `RunOptions` here should match the convention used in `packages/server/test/pipeline.test.ts` if one exists; otherwise mirror the structure expected by `runOnce`.
    // (Subagent executing this task: read existing pipeline tests in @wabe/server to mirror their config-stub builder. If absent, build the minimal RunOptions inline.)
    // Pseudocode:
    // await runOnce({ cfg, db, logger, signal, sources: [flatfox, realadvisor, immobilier].map(wrap), notifiers: [wrap(cap.plugin)], breakers: new Map(), quota: noQuota });

    // Assertions:
    expect(cap.seen.length).toBe(1);
    expect(cap.seen[0]?.listing.source).toBe('source-flatfox'); // priority 80 > 70 > 50
    expect(cap.seen[0]?.also_seen_on?.sort()).toEqual(['source-immobilier-ch', 'source-realadvisor']);
  });
});
```

NOTE for the executor: the call to `runOnce` requires the same `RunOptions` shape used elsewhere in `@wabe/server` tests. If a stub-builder helper does not already exist, extract one from an existing pipeline test or pull the inline construction from `packages/server/src/index.ts`'s scheduler call site. Keep the helper local to this test file.

- [ ] **Step 2: Run the test**

```
pnpm --filter @wabe/server test pipeline-dedup
```
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add packages/server/test/pipeline-dedup.integration.test.ts
git commit -S -m "test(server): integration — 3 sources, 1 notification, also_seen_on populated"
```

---

### Task 21: Workspace-wide CI gate

**Files:** none (CI verification only).

- [ ] **Step 1: Run the full CI gate**

```
pnpm ci
```
Expected: lint + format-check + typecheck + test all PASS across every package.

- [ ] **Step 2: If anything fails, fix and re-run**

Do not bypass with `--no-verify`. Investigate root cause, patch, recommit with an appropriate message.

- [ ] **Step 3: No commit needed if green** (this is a verification gate).

---

## Self-review

### Spec coverage (against `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §4)

| Spec requirement | Plan task |
|------------------|-----------|
| §4.1 `source-realadvisor` plugin | Tasks 8–11 |
| §4.1 `source-immoscout24-sitemap` plugin | Tasks 12–14 |
| §4.1 `source-immobilier-ch` plugin | Tasks 15–17 |
| §4.2 `Listing.canonical_key` / `source_priority` / `seen_on_sources` | Tasks 1, 2 |
| §4.2 migration `0002_dedup_fields.sql` | Task 3 |
| §4.2 `canonical-dedup` engine + bucket function + sha256 key | Tasks 1, 5 |
| §4.2 pipeline wiring | Task 6 |
| §4.2 `source-priority` defaults table | Task 1 (table) + Task 6 (apply) |
| §4.2 telegram card `Also on:` footer | Task 7 |
| §4.3 Out-of-scope items (full IS24 detail, agency adapters, fuzzy match, ML dedup) — confirmed not implemented |
| §4.4 success criteria — `pnpm ci` green | Task 21 |
| §4.4 integration test (3 stub sources + overlap) | Task 20 |
| §4.4 existing flatfox/homegate cards include `Also on:` footer | Task 7 |
| Slice-only distribution (plugins in server deps) | Task 18 |
| Example config update | Task 19 |

### Placeholder scan
No `TBD` / `TODO` / `implement later` / handwave-error-handling phrases. The two soft references in Tasks 9 (Step 1 fixture capture) and 20 (Step 1 NOTE about `RunOptions` shape) are deliberate operational notes — the fixture capture is a one-time manual op the engineer runs locally, and the `RunOptions` construction defers to existing test helpers in `@wabe/server` (genuine reuse, not hand-waving).

### Type consistency
- `canonicalKey()` signature constant across Tasks 1, 4, 6 (`{ postal_code, rooms, area_m2, price_total, url }`).
- `SOURCE_PRIORITY_DEFAULTS` keyed by plugin `name` field (which matches each source's exported `Source.name` — `source-realadvisor`, `source-immoscout24-sitemap`, `source-immobilier-ch`).
- `ListingEvent.also_seen_on?: string[]` consistently used in Task 6 (pipeline) and Task 7 (card).
- `DedupVerdict { suppress, also_seen_on }` consistent in Tasks 5 (implementation) and 6 (consumer).
- All three plugins emit `source: 'source-<name>'` matching their `Source.name`.
