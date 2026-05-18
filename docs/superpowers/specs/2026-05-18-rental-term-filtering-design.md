# Rental-Term Filtering — Design Spec

> Status: **captured**, not yet planned. Convert to implementation plan via `superpowers:writing-plans` when ready.

## Problem

Swiss listing portals (Flatfox, Homegate, etc.) freely mix permanent leases with **temporary / short-term** rentals — furnished sublets, Zwischenmieten, Blueground-style serviced flats — in the same search results. The current Wabe slice has no way to express "I only want a permanent lease" or "I'm only looking for a 2-month sublet between June and August." This causes false-positive notifications.

**Concrete trigger**: Telegram fired for listing `flatfox:1530649` (`Samariterstrasse 8`, score 70). Description: `BEFRISTET BIS 31.05.2025 zu vermieten im Kreis 7` — temporary, already expired. Useless to a user looking for a permanent home.

## Goal

Let users specify their **rental term**:

1. **Long-term**: exclude any listing that is detected as temporary / short-term / furnished-sublet.
2. **Short-term**: include only short-term listings, optionally narrowed by a desired stay window (date range) and/or duration band (months).

Detection works across all current and future source plugins via a shared classifier in `@wabe/core`.

## Design decisions (locked via brainstorm 2026-05-18)

| Question | Choice |
|---|---|
| Detection signals | **Structured fields + description parse** (both) |
| Long-term definition | **Unbestimmt only** — any known lease end date OR explicit short-term flag → short-term. Unknown duration is treated as long-term. |
| Architecture | **Core schema + engine** — new fields on `Listing`, shared classifier helper, surfaced through existing filter DSL. |
| Short-term window | **Both, optional** — user may provide `stay.from/to` dates AND/OR `stay.min_months/max_months`. If both, both must match. |

## Architecture

### 1. Canonical schema extension (`@wabe/core/src/schemas/listing.ts`)

Add two nullable fields to `Listing`:

```ts
rental_term: z.enum(['long', 'short', 'unknown']).default('unknown'),
lease_until: z.coerce.date().nullable().default(null),  // earliest known end date
```

- `rental_term` defaults to `unknown` so existing tests / mappers don't break.
- `lease_until` is set when an end date is parseable. `null` is *not* the same as "no end date" — it means "we did not detect one."

Regenerate JSON Schema (`pnpm --filter @wabe/core build`) so YAML autocomplete picks it up.

### 2. Shared classifier (`@wabe/core/src/engine/rental-term.ts`)

New module. Pure functions, no I/O. Two entry points:

```ts
/** Classify a partial listing using whatever signals are available. */
export function classifyRentalTerm(input: ClassifyInput): {
  rental_term: 'long' | 'short' | 'unknown';
  lease_until: Date | null;
  signal: 'structured' | 'description' | 'both' | 'none';
};

export interface ClassifyInput {
  /** Free-text description in any language. Optional. */
  description?: string | null;
  /** Pre-parsed end date from structured API field, if any. */
  lease_until?: Date | null;
  /** Per-source furnished/serviced/temporary flag. */
  is_furnished?: boolean | null;
  /** Per-source minimum-stay hint in days/months, if any. */
  min_stay_days?: number | null;
}
```

**Decision tree** (first match wins):

1. `lease_until` provided → `short`, carry the date.
2. `is_furnished === true` AND no contrary signal → `short`, no date.
3. Description regex matches a short-term marker (see lexicon) → `short`, parse end date if pattern allows.
4. Description regex matches an explicit long-term marker (e.g. `unbefristet`, `dauerhaft`, `permanent lease`) → `long`.
5. Otherwise → `unknown`.

**Per-listing call site**: source-plugin mappers call `classifyRentalTerm` after building the rest of the canonical listing, then assign the result. Plugins can override individual signals before the call (e.g., Homegate exposes `is_furnished` directly in its API; Flatfox derives it from `object_type === 'FURNISHED_FLAT'`).

### 3. Multilingual lexicon (`@wabe/core/src/engine/rental-term-lexicon.ts`)

Static arrays of regex patterns per signal. Patterns are case-insensitive and tolerant of common formatting variations.

**Short-term markers** (any → `short`):

| Lang | Patterns |
|---|---|
| DE | `befristet`, `zwischenmiete`, `untermiete`, `möbliert(?:e?s?)`, `auf zeit`, `temporär`, `bis\s+\d{1,2}\.\d{1,2}\.\d{2,4}` |
| FR | `temporaire`, `meublé`, `sous-?location`, `bail\s+temporaire`, `jusqu['' ]au\s+\d{1,2}[\./]\d{1,2}` |
| IT | `temporaneo`, `ammobiliato`, `subaffitto`, `fino\s+al\s+\d{1,2}[\./]\d{1,2}` |
| EN | `temporary`, `furnished`, `short[- ]?term`, `sublet`, `serviced apartment`, `until\s+\d{1,2}/\d{1,2}` |

**Long-term markers** (override `unknown` to `long`, do NOT override `short`):

| Lang | Patterns |
|---|---|
| DE | `unbefristet`, `dauermiete`, `langfristig` |
| FR | `bail\s+indéterminé`, `longue\s+durée` |
| IT | `tempo\s+indeterminato`, `lunga\s+durata` |
| EN | `unfurnished`, `long[- ]?term`, `permanent lease` |

**End-date extraction**: when a short-term pattern matches and contains a date capture group, parse with `dayjs` (or native `Date`) under a strict format whitelist (`DD.MM.YYYY`, `DD/MM/YYYY`, `DD.MM.YY`). Reject unparseable strings — leave `lease_until` null rather than guess.

Unit tests are mandatory for every pattern with at least one positive and one negative example. Lexicon lives in its own file so contributors can extend it without touching engine code.

### 4. Per-source mapper changes

Each source plugin's `map.ts` calls the classifier and populates the two new fields. Slice scope:

- `@wabe/source-flatfox`:
  - `is_furnished = (r.object_type === 'FURNISHED_FLAT')`
  - `description` already mapped
  - No structured `lease_until` field — falls back to description parse.
- `@wabe/source-homegate` (deferred): when re-enabled, populate `is_furnished` from `characteristics.is_furnished` (per `homegate-rs`); same description fallback.

Future sources adopt the same pattern. The classifier signature is stable; only mapper wiring changes per source.

### 5. User-facing config

New config file: `~/.config/wabe/rental_term.yaml` (or fold into `filters.yaml` — see Open Questions below).

```yaml
# yaml-language-server: $schema=../../examples/schema/rental_term.schema.json
rental_term:
  mode: long                  # long | short
  # When mode=long: also reject listings whose rental_term is 'unknown'?
  exclude_unknown: false      # default false (strict mode opt-in)

  # Only meaningful when mode=short:
  stay:
    from: 2026-06-01          # optional ISO date; listing must cover this start
    to:   2026-08-31          # optional ISO date; listing must cover this end
    min_months: 1             # optional inclusive
    max_months: 6             # optional inclusive
```

Semantics:

- `mode: long` → keep listings where `rental_term === 'long'`, plus `'unknown'` unless `exclude_unknown: true`.
- `mode: short` → keep listings where `rental_term === 'short'`. Apply `stay` constraints:
  - `stay.from` / `stay.to` → listing must have `available_from <= stay.from` AND (`lease_until == null` OR `lease_until >= stay.to`). Missing `lease_until` on a `short` listing means "indefinitely available" (rare, but possible for furnished-flexible offers) — pass.
  - `stay.min_months` / `stay.max_months` → computed lease length = `(lease_until - available_from)` in months (30.44-day average). Requires both endpoints; if either is null, fall back to "pass" (insufficient data, do not over-reject).
  - If both date and duration constraints are given, BOTH must hold.
- Validation at startup: `mode` is required; `stay.*` are rejected when `mode === 'long'` (loud failure, not silent).

### 6. Engine integration

Two integration paths — picking **6.A** because it minimizes changes to existing filter DSL and keeps the classifier authoritative:

**6.A (chosen)** — add a *post-classify, pre-filter* gate in `packages/server/src/pipeline.ts`:

```
mapped = source.map(raw)
classified = withRentalTerm(mapped, classifyRentalTerm(...))
if !rentalTermGate.passes(classified, cfg.rental_term): continue
... existing filters / scoring ...
```

Gate is a small pure function (`packages/server/src/rental-term-gate.ts`) with its own unit tests. It is independent of the YAML filter DSL — users don't compose rental-term checks inside `filters.yaml`. This keeps the DSL focused on field/expr comparisons and lets the gate emit specific log messages (`filtered out: rental_term=short, user requested long`).

**6.B (rejected)** — extend the filter DSL with a new `kind: 'rental_term'` rule. More uniform, but: gate logic is special-cased (date math, mode coupling) and would bloat the DSL grammar. Rejected on YAGNI grounds.

### 7. CLI surface

- `wabe doctor`: validate `rental_term.yaml` shape + cross-check `mode` vs `stay.*` presence.
- `wabe init`: prompt the user (`@clack/prompts`) for long vs short on first run. Long is the default. If short, ask for stay window + duration band. Write `rental_term.yaml`. Idempotent — never overwrites without `--force`.
- `wabe list`: surface `rental_term` and `lease_until` columns when present.

## Testing

Mandatory before merge:

1. **Lexicon tests** (`@wabe/core/test/rental-term-lexicon.test.ts`): table-driven, every pattern has ≥1 positive + ≥1 negative example. The Samariterstrasse 8 description (`BEFRISTET BIS 31.05.2025…`) is committed as a fixture and must classify `short` with `lease_until = 2025-05-31`.
2. **Classifier tests** (`@wabe/core/test/rental-term.test.ts`): decision-tree branch coverage. Includes the "conflict" case (description says `möbliert` but `lease_until` is in the structured field → `short`, prefer structured date).
3. **Gate tests** (`@wabe/server/test/rental-term-gate.test.ts`): every combination of mode × `exclude_unknown` × `stay` constraint shape × known/unknown lease window. Date-arithmetic tests use frozen `Date.now()`.
4. **Mapper updates**: `@wabe/source-flatfox` mapper test must assert that the existing fixtures classify correctly (existing fixtures are all unfurnished / unknown — add at least one furnished + one `befristet` fixture).
5. **Gate test in `examples/zurich-family/`**: assert the reference config sets a `rental_term.mode` and survives engine validation.
6. **Integration test in `@wabe/server`**: end-to-end fixture source emits one long-term + one short-term listing; verify only the long-term one reaches the notifier when `mode: long`.

CI gate: lexicon changes without paired test updates fail the suite (enforce via a small test that walks the lexicon arrays and asserts every entry has a test fixture).

## Migration / rollout

- DB: no migration needed. `rental_term` and `lease_until` ride along inside the `payload` JSON column on `listings`.
- Existing user installs: on first `wabe scan` after upgrade, no `rental_term.yaml` → engine defaults to `mode: long, exclude_unknown: false` (preserves current behavior; furnished-sublet false positives remain until user opts in). A `wabe doctor` warning nudges users to run `wabe init --rental-term` (or hand-edit) to make the choice explicit.
- Telegram card: append a `🗓 short-term · until 31.05.2025` line below the existing rooms/area row when `rental_term === 'short'`. Long-term and unknown emit no extra line (no noise).

## Open questions

These are NOT blockers but should be resolved during planning:

1. **Where does the config live?** Standalone `rental_term.yaml` (proposed) or a new top-level key in `filters.yaml`? Standalone is cleaner for first-time users (`wabe init` writes one file per concern); folded-in is fewer files. Recommend standalone.
2. **Should `unknown` ever auto-classify as `short`?** E.g., listings with `price.total > 4500 CHF` AND `area_m2 < 50` are statistically more likely to be furnished sublets. Out of scope here — handle as a future scoring dim if needed.
3. **Should we expire-check `lease_until`?** A `short` listing whose `lease_until < today` is useless even to short-term searchers. Recommend: yes, reject in the gate regardless of `mode`. Trivial to add.
4. **Telegram opt-in cards for short-term users?** When `mode: short`, surface the parsed duration prominently and the photo of the furnished interior (currently `photos: []` from Flatfox — separate fix).

## Out of scope

- Detecting *seasonal* vs *furnished sublet* vs *Zwischenmiete* sub-categories. Phase 1 keeps the binary long/short distinction.
- LLM-based classification. The regex lexicon is deterministic and cheap; revisit only if false-negative rate proves unacceptable in production.
- Per-source overrides of the global rental-term policy. If a future use case demands "long-term on Homegate, any on Flatfox," add a `per_source:` map; not needed now.

## Files to touch (forward reference for plan)

- `packages/core/src/schemas/listing.ts` — add `rental_term`, `lease_until`.
- `packages/core/src/engine/rental-term.ts` — new classifier.
- `packages/core/src/engine/rental-term-lexicon.ts` — new pattern set.
- `packages/core/test/rental-term*.test.ts` — new tests.
- `packages/server/src/rental-term-gate.ts` — new gate.
- `packages/server/src/pipeline.ts` — wire gate in before `filters.evaluate`.
- `packages/server/test/rental-term-gate.test.ts` — new tests.
- `packages/server/src/config.ts` — load `rental_term.yaml`, validate.
- `packages/cli/src/commands/init.ts` — interactive prompts.
- `packages/cli/src/commands/doctor.ts` — validation check.
- `packages/cli/src/commands/list.ts` — surface columns.
- `plugins/source-flatfox/src/map.ts` — populate `rental_term`, `lease_until` via classifier.
- `plugins/source-flatfox/test/fixtures/responses/*.json` — add a `FURNISHED_FLAT` and a `befristet` fixture.
- `plugins/notifier-telegram/src/card.ts` — short-term row.
- `examples/zurich-family/config/rental_term.yaml` — reference config.
- `examples/schema/rental_term.schema.json` — generated.
- `docs/superpowers/plans/YYYY-MM-DD-rental-term-filtering.md` — implementation plan (next step).
- Plugin READMEs touched: `plugins/source-flatfox/README.md` — document new mapper outputs.
