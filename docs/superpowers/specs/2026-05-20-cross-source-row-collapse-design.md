---
date: 2026-05-20
status: design
topic: Cross-source row collapse — one DB row per logical listing
supersedes:
  - packages/server/src/dedupe.ts upsertListing (multi-row per canonical_key model)
related:
  - packages/server/src/canonical-dedup.ts
  - packages/core/src/canonical-key.ts
  - docs/superpowers/specs/2026-05-19-immoscout24-search-source-design.md (non-goal item that motivated this)
---

# Cross-source row collapse

## Goal

Replace the per-(source, listing) row model in `listings` with one fat row per
logical listing, keyed by `canonical_key`. Second-source observations enrich
the existing row with priority-resolved fields; the notifier only fires on
the FIRST canonical-row insert. Photos are unioned across sources; enriched
metadata is deep-merged.

Today: every `(source, source_id)` pair gets its own row; `shouldNotify`
suppresses lower-priority arrivals across rows. That works for notifications
but leaves the DB with N rows per logical listing — wasteful queries,
ambiguous "which row is canonical", and per-source field drift never
reconciled.

After this spec: one row per logical listing, fields resolved by source
priority + ties on `first_seen_at`, photos unioned, enriched deep-merged.

## Non-goals

- Cross-source dedup heuristics beyond `canonical_key` bucketing. The
  bucketing logic in `canonical-key.ts` is unchanged.
- Notifier-side card formatting changes beyond what already reads
  `seen_on_sources` for the "Also on:" footer.
- Re-notifying on second-source arrival (would require Telegram message-edit
  state which is a separate spec). Subsequent observations silently enrich.
- Per-source observation audit table. The migration retains `listings_legacy`
  for one milestone as a safety net; long-term audit is a future spec.

## Architecture

```
source plugin yields RawListing
        │
        ▼
canonicalKey({postal_code, rooms, area_m2, price, url})
        │
        ▼
mergeUpsertCanonical(db, raw, ck)
        ├─ row exists at ck?
        │      ├─ yes → resolveFields(existing, raw); UPDATE if changed.
        │      │       Return { isNew: false, changed }.
        │      └─ no  → INSERT row materialised from raw.
        │               Return { isNew: true, changed: true }.
        ▼
enricher stage (commute, …) — runs only on isNew
        ▼
filter → score → notify
                  └─ shouldNotify(upsertResult) = { suppress: !isNew, also_seen_on }
```

### Components

**`packages/server/src/merge.ts`** (NEW) — pure `resolveFields(existing, raw)`
function. No DB access. Returns a fully-resolved `Listing` and a `changed`
flag. All field-resolution rules live here. Easy to unit-test.

**`packages/server/src/dedupe.ts`** — rewritten. New surface:

```ts
export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
}
export function mergeUpsertCanonical(
  db: WabeDb,
  raw: RawListing,
  ck: string,
): UpsertResult;
```

The `upsertListing(db, listing)` export is removed.

**`packages/server/src/canonical-dedup.ts`** — `shouldNotify` simplified:

```ts
export interface DedupVerdict { suppress: boolean; also_seen_on: string[]; }
export function shouldNotify(
  upsertResult: UpsertResult,
  listing: Listing,
): DedupVerdict {
  return {
    suppress: !upsertResult.isNew,
    also_seen_on: upsertResult.isNew ? [] : listing.seen_on_sources.filter((s) => s !== listing.source),
  };
}
```

The `db` parameter goes away — no per-canonical_key SELECT needed.

**`packages/server/src/pipeline.ts:runSource`** — replaces the call chain:

```ts
// before
const result = upsertListing(opts.db, parsed);
// … notify path
const verdict = shouldNotify(opts.db, parsed);
```

```ts
// after
const result = mergeUpsertCanonical(opts.db, raw, ck);
// re-read the materialised row so notify sees the merged listing:
const merged = readListing(opts.db, ck);
// enricher stage only on isNew
if (result.isNew) {
  // run enrichers …
}
const verdict = shouldNotify(result, merged);
```

## Listing schema delta

`packages/core/src/schemas/listing.ts` is **not changed structurally**. The
fields keep their shape; their meanings shift:

| Field | After collapse |
|---|---|
| `id` | = `canonical_key` (sha256 hex) — constant per row |
| `source` | authoritative source (highest-priority contributor; tie → older `first_seen_at`) |
| `url` | URL from authoritative source |
| `canonical_key` | unchanged; now also the PK |
| `source_priority` | authoritative source's priority |
| `seen_on_sources[]` | sorted union of all sources that have ever contributed |
| `photos[]` | dedup-union across all contributing sources; authoritative source's photos first |
| Scalars (price.*, rooms, area_m2, floor, …, description, agency, contact.*) | priority-wins with null-skip |
| `enriched.*` | deep-merged across contributing sources; enricher output layered on top |
| `extra.*` | priority-wins per key |

**New convention** (not a schema change — just documented placement under the
existing `enriched` record):

- `enriched.external_ids: Record<string, string>` — `{ "homegate": "hg-123",
  "realadvisor": "ra-456" }`. Materialised at merge time from each
  contributing source's `RawListing.id` (or the per-plugin id derived from it
  — e.g. `homegate:hg-123` → key `"homegate"`, value `"hg-123"`).

`RawListing` schema is unchanged. Sources still emit per-source `id`,
`source`, `url`. The pipeline resolves to canonical at upsert time.

## Field-resolution rules

`resolveFields(existing: Listing, raw: RawListing): { next: Listing; changed: boolean }`:

| Field | Rule |
|---|---|
| `id` | = `canonical_key` (constant after first insert) |
| `source` | authoritative-source rule (see below) |
| `url` | URL from the authoritative source |
| `source_priority` | priority of authoritative source |
| `first_seen_at` | min(existing, raw) |
| `last_seen_at` | max(existing, raw, now()) |
| `price.{rent_net,extras,total,currency,deposit_months}` | priority-wins per leaf, null-skip |
| `rooms`, `area_m2`, `floor`, `total_floors`, `built_year`, `renovated_year` | priority-wins, null-skip |
| `location.{coords,address,postal_code,city,region,country,neighborhood}` | priority-wins per leaf, null-skip |
| `description`, `agency` | priority-wins, null-skip |
| `contact.{phone,email,form_url}` | priority-wins per leaf, null-skip |
| `features` | shallow-merge with priority-wins per key |
| `photos` | dedup-union by URL equality; authoritative source's photos first, then other sources in priority-descending order |
| `available_from`, `lease_until` | priority-wins, null-skip |
| `rental_term` | priority-wins, but `'unknown'` always loses to `'long'` / `'short'` regardless of priority |
| `enriched.*` | deep-merge per leaf; conflicts resolved priority-wins; array leaves union-dedup |
| `extra.*` | priority-wins per key |
| `canonical_key` | unchanged |
| `seen_on_sources` | sorted union |

**Authoritative-source rule:** the source with the highest `source_priority`
among current contributors. Ties broken by `first_seen_at` (older wins,
stable). When a higher-priority source first arrives at an existing row, the
authoritative source switches; `source`, `url`, `source_priority` update
accordingly.

**Null-skip semantics:** if the would-be winner has `null` for a field and a
lower-priority source has a non-null value, the lower-priority value wins for
that field only. Prevents loss of useful data when the priority source
omitted a field.

**Conservative `changed` flag:** `changed = true` only when the merged
payload's JSON differs from the existing payload. Avoids no-op UPDATEs.

## Notifier behavior

`shouldNotify` is consulted once per pipeline iteration. Verdict shape
unchanged — `{ suppress, also_seen_on }`. Logic simplified to:

- `suppress = !upsertResult.isNew`
- `also_seen_on = isNew ? [] : seen_on_sources.filter(s => s !== authoritative_source)`

The notifier card (`plugins/notifier-telegram/src/card.ts`) already renders
`also_seen_on` as the "Also on:" footer. No card-side changes required.

Future spec (not in this scope): on second-source observation, optionally
edit the original Telegram message to update the "Also on:" footer.
Requires storing `message_id` per notification.

## Persistence

Schema delta in `packages/db/migrations/0005_collapse_canonical.sql`:

```sql
-- Snapshot pre-collapse rows so a rollback is possible without re-fetching.
CREATE TABLE listings_legacy AS SELECT * FROM listings;

-- Recreate listings with canonical_key as PK. Same column shape as before
-- (the JSON payload still carries the full Listing); the only structural
-- difference is the PK.
ALTER TABLE listings RENAME TO listings_old;
CREATE TABLE listings (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  payload         TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',
  canonical_key   TEXT NOT NULL,
  source_priority INTEGER NOT NULL,
  seen_on_sources TEXT NOT NULL
);
CREATE INDEX listings_canonical_key_idx ON listings(canonical_key);
```

**TS-side migration runner** at
`packages/db/src/collapse-listings.ts` is invoked by `migrate.ts` immediately
after `0005_collapse_canonical.sql` applies:

1. Iterate every row in `listings_old`, grouping by `canonical_key`.
2. For each group, fold all rows through `resolveFields()` from
   `@wabe/server` (older `first_seen_at` first, so ties resolve correctly).
3. Materialise one row per group into the new `listings` table. `id` is set
   to `canonical_key`. `payload` is the fully-resolved `Listing`'s JSON.
   `enriched.external_ids` is populated from each contributing row's `id`.
4. `DROP TABLE listings_old`.

The runner is idempotent: if the new `listings` table already has rows for
some `canonical_key`s, it merges them with the legacy rows the same way. Safe
to re-run after a partial failure.

**Module-boundary note:** the runner lives in `@wabe/db` but imports
`resolveFields` from `@wabe/server`. To avoid a cycle, `resolveFields` is
exported through a dedicated `@wabe/server/merge` sub-entry; `@wabe/db` has a
NEW devDep on `@wabe/server`. Acceptable because the runner is migration-only
code, not part of `@wabe/db`'s runtime path.

Alternative if the cycle proves messy: move `resolveFields` to `@wabe/core`
(it's a pure function over `Listing` and source-priority lookup). Decided at
plan time; either path is mechanical.

## Rollback

Reversible until the next milestone drops `listings_legacy`. Manual recipe:

```sql
BEGIN;
DROP TABLE listings;
ALTER TABLE listings_legacy RENAME TO listings;
COMMIT;
```

Wrapped in a CLI subcommand `wabe db rollback-collapse` (new file in
`packages/cli/src/commands/db.ts`) that:

1. Errors if `listings_legacy` is missing.
2. Errors if `_migrations` has migrations later than `0005` applied (the
   schema may have diverged).
3. Otherwise runs the SQL above plus `DELETE FROM _migrations WHERE name =
   '0005_collapse_canonical.sql'` so the migrator re-applies the collapse on
   the next start.

`listings_legacy` is dropped one milestone post-merge via migration 0006 (or
later, after stability is observed).

## Affected files

```
packages/core/src/schemas/listing.ts            # doc-only: clarify field semantics after collapse
packages/server/src/merge.ts                    # NEW: resolveFields() pure function
packages/server/src/dedupe.ts                   # rewrite: mergeUpsertCanonical
packages/server/src/canonical-dedup.ts          # simplify shouldNotify
packages/server/src/pipeline.ts                 # pass UpsertResult to shouldNotify; enricher only on isNew
packages/server/test/merge.test.ts              # NEW: per-field resolution tests
packages/server/test/dedupe.test.ts             # rewrite
packages/server/test/canonical-dedup.test.ts    # simplify
packages/server/test/integration.test.ts        # NEW or extend: stub A + stub B, assert notify-once
packages/db/migrations/0005_collapse_canonical.sql
packages/db/src/migrate.ts                      # invoke collapse runner after 0005 applies
packages/db/src/collapse-listings.ts            # NEW: TS migration runner
packages/db/test/migrate-collapse.test.ts       # NEW
packages/db/package.json                        # devDep on @wabe/server (migration-only)
packages/cli/src/commands/db.ts                 # NEW: wabe db rollback-collapse
packages/cli/src/index.ts                       # register the db subcommand
README.md                                       # document the canonical-row model
CLAUDE.md                                       # update "Architecture summary" to describe the new model
```

## Testing

- **`merge.test.ts`** — per-field resolution table tests:
  - priority-wins for each scalar
  - null-skip for each nullable field
  - tie-break on `first_seen_at`
  - photos union: order (authoritative first), dedup by URL
  - `enriched.*` deep-merge with priority-wins
  - `rental_term`: `'unknown'` loses to `'long'` regardless of priority
  - `seen_on_sources` sorted union
  - `enriched.external_ids` accumulation
- **`dedupe.test.ts`** — full upsert path:
  - first arrival → INSERT, `isNew: true, changed: true`
  - same source, same fingerprint → `isNew: false, changed: false`
  - same source, payload drift → `isNew: false, changed: true`
  - second source, lower priority → row updates only null fields + photos union; `isNew: false`
  - second source, higher priority → authoritative switches; previous source's fields preserved where higher-priority source has nulls
  - `enriched.external_ids` accumulates across sources
- **`canonical-dedup.test.ts`** — `shouldNotify`:
  - returns `suppress: false, also_seen_on: []` on isNew=true
  - returns `suppress: true, also_seen_on: [<other sources>]` on isNew=false
  - filters authoritative source out of `also_seen_on`
- **`integration.test.ts`** — pipeline E2E:
  - stub source A (priority 70) emits a listing — notify fires
  - stub source B (priority 50) emits same canonical_key with photos and a phone — second notify is SUPPRESSED, row carries union of A+B
  - stub source C (priority 80) arrives — authoritative switches to C, source/url update, fields not nulled by C preserved; STILL no notify (already notified at A)
- **`migrate-collapse.test.ts`** — collapse runner:
  - seed `listings` with 3 source rows sharing one `canonical_key` and 1 standalone row
  - run migration, assert 2 rows in new `listings` table
  - assert authoritative resolution matches priority + first_seen_at
  - re-run migration — no-op (idempotent)
- **No live network calls in CI** (matches existing convention).

## Bridge / external integration impact

None. The bridge is downstream of `mergeUpsertCanonical` only by virtue of
source plugins making HTTPS calls; the merge itself never touches the
network. Telegram notifier card already reads `seen_on_sources` so no card
change required.

## Performance considerations

Per-scan write cost is roughly unchanged: previously N source rows per
canonical_key were inserted/updated; now one row is inserted + updated N-1
times. UPDATE-with-no-change is short-circuited by the `changed` flag.

Read cost drops: cross-source queries (`wabe list`, scoring, filters) no
longer scan multiple rows per logical listing.

Migration cost: O(N) over `listings_old` once. For the 47k IS24-sitemap rows
historically observed (issue #6, now closed), expected runtime ~few seconds.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Migration crashes mid-run, leaving `listings_old` orphaned | Migration runner is idempotent; restart re-runs and finishes. `listings_legacy` snapshot is taken first; rollback works. |
| `resolveFields` has a subtle bug, corrupts data | `listings_legacy` retained one milestone; `wabe db rollback-collapse` is a single command. |
| Priority-wins surfaces unexpected results (e.g. homegate's stale price replaces realadvisor's fresh price) | First-seen-at tie break is stable per scan ordering. Per-field `last_seen_at` could be added in a future spec if priority alone proves wrong. |
| Enriched fields written by enrichers (commute) compete with source-emitted enriched fields | Enrichers run AFTER `mergeUpsertCanonical` and overwrite enriched namespace they own (e.g. `enriched.commute`). No conflict. |
| Module cycle `@wabe/db` ↔ `@wabe/server` via `resolveFields` | Migration-only devDep on `@wabe/server` from `@wabe/db`. Alternative: move `resolveFields` to `@wabe/core`. Decided at plan time. |
| `_migrations` table doesn't track 0005's TS-side runner separately, leaving the DB in a partial state if the SQL applies but the TS runner crashes | The migration runner is invoked synchronously from within the same transaction window as the SQL migration. If it throws, the SQL is rolled back. (Existing `migrate.ts` already wraps each migration in a transaction.) |

## Rollout

Single PR; one milestone. No phased rollout. Migration runs at first start
post-merge. `listings_legacy` removed one milestone later by migration 0006.

## Open questions for plan phase

None blocking. The `@wabe/db` → `@wabe/server` devDep direction is decided
inline above; either path is mechanical at code time.
