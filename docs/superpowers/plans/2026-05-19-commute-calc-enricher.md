# Commute Calc Enricher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@wabe/enricher-commute` (first Enricher plugin), wire the enricher stage into the pipeline (loaded but never invoked until now), extend the DSL with a `commute(target, mode)` primitive consumable by filters + scorers, and ship a self-hosted ORS + Motis + Pelias docker-compose recipe.

**Architecture:** Per-listing flow — geocode missing coords via Pelias (cached in SQLite), then for each configured target × mode compute travel duration via ORS (car/bike/foot) or Motis (PT), cache results, write under `listing.enriched.commute`. Pipeline gains an enricher stage between upsert and the rental-term gate. DSL adds a typed `commute` primitive for both `FilterRule` and `RuleDim.metric` paths. Routing-provider adapters live inside the enricher package; no SDK-level abstraction.

**Tech Stack:** TypeScript, Zod, undici (with MockAgent for tests), better-sqlite3 (via `@wabe/db`), Vitest, pino, docker-compose for ORS/Motis/Pelias. Spec: `docs/superpowers/specs/2026-05-19-commute-calc-enricher-design.md`.

**Sequencing:** All tasks share `@wabe/core` + `@wabe/db` + `@wabe/server` foundations. T1–T3 are infra (DSL grammar + migration + plugin scaffold). T4–T7 are leaf adapters that could run in parallel worktrees once scaffolding lands. T8–T12 are integration + wiring. Single-worktree linear execution is fine for this size; parallelism noted where it's available.

---

## File map

### New files

| Path | Purpose |
|------|---------|
| `plugins/enricher-commute/package.json` | New workspace package `@wabe/enricher-commute` |
| `plugins/enricher-commute/tsconfig.json` | Project references to core + plugin-sdk + db |
| `plugins/enricher-commute/src/index.ts` | Default export `{ kind:'enricher', plugin }` + plugin object |
| `plugins/enricher-commute/src/schemas.ts` | Zod `CommuteConfig`, `CommutePayload`, `CommuteMode` |
| `plugins/enricher-commute/src/cache.ts` | better-sqlite3 cache adapter (commute + geocode) |
| `plugins/enricher-commute/src/geocode.ts` | Pelias `/v1/search` adapter |
| `plugins/enricher-commute/src/route-ors.ts` | ORS `/v2/directions/{profile}` adapter |
| `plugins/enricher-commute/src/route-motis.ts` | Motis `/api/v1/plan` adapter |
| `plugins/enricher-commute/src/enrich.ts` | `enrich(listing, ctx)` orchestration |
| `plugins/enricher-commute/src/time.ts` | `nextWeekdayAt()` helper |
| `plugins/enricher-commute/test/cache.test.ts` | Cache unit tests |
| `plugins/enricher-commute/test/geocode.test.ts` | Pelias adapter tests (undici MockAgent) |
| `plugins/enricher-commute/test/route-ors.test.ts` | ORS adapter tests |
| `plugins/enricher-commute/test/route-motis.test.ts` | Motis adapter tests |
| `plugins/enricher-commute/test/time.test.ts` | Time helper tests |
| `plugins/enricher-commute/test/enrich.integration.test.ts` | Full `enrich()` flow with mocked HTTP |
| `plugins/enricher-commute/test/fixtures/pelias-zurich.json` | Pelias response fixture |
| `plugins/enricher-commute/test/fixtures/ors-cycling.json` | ORS response fixture |
| `plugins/enricher-commute/test/fixtures/motis-itinerary.json` | Motis response fixture |
| `plugins/enricher-commute/README.md` | Plugin docs |
| `packages/db/migrations/0003_commute_cache.sql` | `commute_cache` + `geocode_cache` tables |
| `packages/core/test/dsl-commute.test.ts` | DSL primitive tests |
| `packages/server/test/pipeline-enrich.integration.test.ts` | Enricher-stage integration test |
| `packages/cli/src/commands/cache.ts` | `wabe cache clear --commute` |
| `docker/commute/compose.yml` | Self-hosted routing stack |
| `docker/commute/README.md` | Setup + maintenance docs |
| `docker/commute/Makefile` | `make data` / `make health` / `make refresh-gtfs` |
| `docker/commute/ors-config.yml.example` | Sample ORS config |
| `docker/commute/pelias-config.json.example` | Sample Pelias config |
| `docker/commute/.gitignore` | Ignore data/ + ors-data/ + motis-data/ + pelias-es-data/ |
| `examples/zurich-family/commute.yaml` | Example user-facing config |

### Modified files

| Path | Change |
|------|--------|
| `packages/core/src/schemas/dsl.ts` | Add `CommutePrimitive`, extend `FilterRule` discriminated union with `'commute'` branch, extend `RuleDim.metric` to accept primitive |
| `packages/core/src/index.ts` | Re-export `CommutePrimitive` + helpers |
| `packages/server/src/pipeline.ts` | Insert enricher stage between upsert and rental-term gate |
| `packages/server/src/config.ts` | Confirm `enrichers` config already plumbed; add `commute.yaml` per-enricher config_path loader if absent |
| `packages/cli/src/index.ts` | Register `cache` command |
| `packages/cli/src/commands/doctor.ts` | Add commute-endpoints probe |
| `examples/zurich-family/config.yaml` | Enable enricher-commute |
| `examples/zurich-family/scoring.yaml` | Sample commute-aware rule |
| `examples/zurich-family/filters.yaml` | Sample commute filter |
| `README.md` | Document enricher + commute calc + docker stack |

---

## Task 1: DB migration — commute_cache + geocode_cache

**Files:**
- Create: `packages/db/migrations/0003_commute_cache.sql`

- [ ] **Step 1: Write the migration SQL.**

Create `packages/db/migrations/0003_commute_cache.sql`:

```sql
CREATE TABLE commute_cache (
  from_lat_q     REAL    NOT NULL,
  from_lng_q     REAL    NOT NULL,
  to_target      TEXT    NOT NULL,
  mode           TEXT    NOT NULL,
  weekday        TEXT    NOT NULL,
  arrive_by_min  INTEGER NOT NULL,
  duration_s     INTEGER NOT NULL,
  distance_m     INTEGER NOT NULL,
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (from_lat_q, from_lng_q, to_target, mode, weekday, arrive_by_min)
);

CREATE TABLE geocode_cache (
  address_norm TEXT PRIMARY KEY,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  computed_at  INTEGER NOT NULL
);
```

- [ ] **Step 2: Apply the migration locally to verify it parses.**

Run: `pnpm --filter @wabe/db build && rm -f /tmp/wabe-mig.db && node -e "const Database=require('better-sqlite3');const fs=require('fs');const db=new Database('/tmp/wabe-mig.db');for(const f of ['0001_init.sql','0002_dedup_fields.sql','0003_commute_cache.sql']){db.exec(fs.readFileSync('packages/db/migrations/'+f,'utf8'));}console.log('OK');"`

Expected: prints `OK`.

- [ ] **Step 3: Commit.**

```bash
git add packages/db/migrations/0003_commute_cache.sql
git commit -m "db: add commute_cache + geocode_cache tables (commute enricher)"
```

---

## Task 2: DSL — CommutePrimitive + FilterRule branch + RuleDim.metric extension

**Files:**
- Modify: `packages/core/src/schemas/dsl.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/dsl-commute.test.ts`

- [ ] **Step 1: Write failing tests first.**

Create `packages/core/test/dsl-commute.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FilterRule, RuleDim, CommutePrimitive, CommuteMode } from '../src/schemas/dsl.js';

describe('CommutePrimitive', () => {
  it('parses a valid primitive', () => {
    const p = CommutePrimitive.parse({ kind: 'commute', target: 'work', mode: 'transit' });
    expect(p).toEqual({ kind: 'commute', target: 'work', mode: 'transit' });
  });
  it('rejects unknown mode', () => {
    expect(() => CommutePrimitive.parse({ kind: 'commute', target: 'work', mode: 'magic' })).toThrow();
  });
});

describe('CommuteMode', () => {
  it('enumerates the four supported modes', () => {
    expect(CommuteMode.options).toEqual(['transit', 'cycling', 'walking', 'driving']);
  });
});

describe('FilterRule commute branch', () => {
  it('parses a commute filter rule', () => {
    const r = FilterRule.parse({
      kind: 'commute',
      target: 'work',
      mode: 'transit',
      op: '<=',
      value: 30,
      on_missing: 'fail',
    });
    expect(r.kind).toBe('commute');
  });
  it('rejects non-numeric value for commute filter', () => {
    expect(() =>
      FilterRule.parse({ kind: 'commute', target: 'work', mode: 'transit', op: '<=', value: 'soon' }),
    ).toThrow();
  });
});

describe('RuleDim.metric commute primitive', () => {
  it('accepts a CommutePrimitive in metric', () => {
    const d = RuleDim.parse({
      type: 'rule',
      name: 'work_commute',
      weight: 0.4,
      metric: { kind: 'commute', target: 'work', mode: 'transit' },
      normalize: { type: 'linear', best: 0, worst: 60 },
    });
    expect(d.metric).toEqual({ kind: 'commute', target: 'work', mode: 'transit' });
  });
  it('still accepts a string metric (back-compat)', () => {
    const d = RuleDim.parse({
      type: 'rule',
      name: 'price',
      weight: 0.3,
      metric: 'price.total',
      normalize: { type: 'linear', best: 1000, worst: 4000 },
    });
    expect(d.metric).toBe('price.total');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL ("Cannot find module").**

Run: `pnpm --filter @wabe/core test -- dsl-commute`
Expected: FAIL — `CommutePrimitive`, `CommuteMode` not exported, FilterRule rejects new branch.

- [ ] **Step 3: Extend `dsl.ts`.**

In `packages/core/src/schemas/dsl.ts`, immediately after `FilterOp` definition add:

```ts
/** Supported travel modes for the commute primitive. */
export const CommuteMode = z.enum(['transit', 'cycling', 'walking', 'driving']);
export type CommuteMode = z.infer<typeof CommuteMode>;

/** Reusable commute primitive: resolves to minutes (or Infinity if unavailable). */
export const CommutePrimitive = z.object({
  kind: z.literal('commute'),
  target: z.string().min(1),
  mode: CommuteMode,
});
export type CommutePrimitive = z.infer<typeof CommutePrimitive>;
```

Replace the existing `FilterRule` definition with the three-branch union:

```ts
export const FilterRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('field'),
    field: z.string(),
    op: FilterOp,
    value: z.unknown(),
    on_missing: OnMissingFilter,
  }),
  z.object({
    kind: z.literal('expr'),
    expr: z.string(),
    on_missing: OnMissingFilter,
  }),
  z.object({
    kind: z.literal('commute'),
    target: z.string().min(1),
    mode: CommuteMode,
    op: z.enum(['<', '<=', '==', '!=', '>=', '>']),
    value: z.number(),
    on_missing: OnMissingFilter,
  }),
]);
export type FilterRule = z.infer<typeof FilterRule>;
```

Replace `RuleDim` with the metric-extended version:

```ts
const RuleDim = z.object({
  type: z.literal('rule'),
  name: z.string(),
  weight: z.number().positive(),
  metric: z.union([z.string(), CommutePrimitive]),
  normalize: Normalize,
  on_missing: OnMissingDim,
});
```

- [ ] **Step 4: Export the new symbols.**

In `packages/core/src/index.ts`, add to the existing export block:

```ts
export { CommuteMode, CommutePrimitive } from './schemas/dsl.js';
export type { CommuteMode as CommuteModeT, CommutePrimitive as CommutePrimitiveT } from './schemas/dsl.js';
```

(Type re-exports are aliased to avoid collision with the value exports.)

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/core test -- dsl-commute`
Expected: 5 tests pass.

- [ ] **Step 6: Run the full core test suite — verify back-compat.**

Run: `pnpm --filter @wabe/core test`
Expected: all tests pass, including the existing scoring + filter suites.

- [ ] **Step 7: Commit.**

```bash
git add packages/core/src/schemas/dsl.ts packages/core/src/index.ts packages/core/test/dsl-commute.test.ts
git commit -m "core(dsl): commute primitive for filters + scoring metrics"
```

---

## Task 3: Filter evaluator — commute branch

**Files:**
- Modify: `packages/core/src/filter.ts` (existing evaluator)
- Modify: `packages/core/test/filter.test.ts` (add commute coverage)

- [ ] **Step 1: Locate the existing filter evaluator.**

Run: `grep -n "evaluateFilters\\|kind ===" packages/core/src/filter.ts`
Read the file to understand how `'field'` and `'expr'` branches are dispatched.

- [ ] **Step 2: Write failing tests.**

Append to `packages/core/test/filter.test.ts`:

```ts
describe('evaluateFilters - commute branch', () => {
  const baseListing = {
    id: 'a',
    source: 's',
    url: 'https://x/a',
    enriched: { commute: { work: { transit: { duration_min: 25, distance_km: 8, computed_at: new Date() } } } },
  } as any;

  it('passes when commute duration <= threshold', async () => {
    const r = await evaluateFilters(
      [{ kind: 'commute', target: 'work', mode: 'transit', op: '<=', value: 30, on_missing: 'fail' }],
      baseListing,
    );
    expect(r.passed).toBe(true);
  });

  it('rejects when commute duration > threshold', async () => {
    const r = await evaluateFilters(
      [{ kind: 'commute', target: 'work', mode: 'transit', op: '<=', value: 20, on_missing: 'fail' }],
      baseListing,
    );
    expect(r.passed).toBe(false);
  });

  it('treats missing target as Infinity (fails strict op with on_missing:fail)', async () => {
    const r = await evaluateFilters(
      [{ kind: 'commute', target: 'gym', mode: 'transit', op: '<=', value: 30, on_missing: 'fail' }],
      baseListing,
    );
    expect(r.passed).toBe(false);
  });

  it('passes when missing target + on_missing:pass', async () => {
    const r = await evaluateFilters(
      [{ kind: 'commute', target: 'gym', mode: 'transit', op: '<=', value: 30, on_missing: 'pass' }],
      baseListing,
    );
    expect(r.passed).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL ("kind 'commute' not handled").**

Run: `pnpm --filter @wabe/core test -- filter`
Expected: FAIL — commute branch unimplemented.

- [ ] **Step 4: Implement the commute branch in the evaluator.**

In `packages/core/src/filter.ts`, in the body of `evaluateFilters` (or its per-rule helper), add a new branch above the existing default. The exact insertion point depends on the file's current shape; the contract:

```ts
if (rule.kind === 'commute') {
  const path = ['enriched', 'commute', rule.target, rule.mode, 'duration_min'];
  let val: unknown = listing;
  for (const k of path) {
    if (val == null || typeof val !== 'object') { val = undefined; break; }
    val = (val as Record<string, unknown>)[k];
  }
  const minutes = typeof val === 'number' ? val : Number.POSITIVE_INFINITY;
  if (minutes === Number.POSITIVE_INFINITY) {
    if (rule.on_missing === 'pass') continue;        // rule does not constrain
    if (rule.on_missing === 'skip') continue;        // same effect for AND-combined filters
    return { passed: false, reason: `commute(${rule.target},${rule.mode}) missing` };
  }
  const ops: Record<typeof rule.op, (a: number, b: number) => boolean> = {
    '<':  (a, b) => a < b,
    '<=': (a, b) => a <= b,
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b,
    '>=': (a, b) => a >= b,
    '>':  (a, b) => a > b,
  };
  if (!ops[rule.op](minutes, rule.value)) {
    return { passed: false, reason: `commute(${rule.target},${rule.mode}) ${minutes} !${rule.op} ${rule.value}` };
  }
  continue;
}
```

If the existing evaluator is structured as a per-rule helper that returns `boolean`, adapt the branch to that shape (return `true` on pass, `false` on fail; surface the reason via the helper's existing channel).

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/core test -- filter`
Expected: 4 new tests pass; existing filter tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/filter.ts packages/core/test/filter.test.ts
git commit -m "core(filter): evaluate commute primitive branch"
```

---

## Task 4: Scoring metric resolver — commute primitive

**Files:**
- Modify: `packages/core/src/scoring.ts` (existing engine)
- Modify: `packages/core/test/scoring.test.ts`

- [ ] **Step 1: Locate the metric-resolution code.**

Run: `grep -n "metric\\|resolveMetric\\|JSONata\\|jsonata" packages/core/src/scoring.ts`
Read the function that turns `dim.metric` into a number.

- [ ] **Step 2: Write failing tests.**

Append to `packages/core/test/scoring.test.ts`:

```ts
describe('scoring - commute primitive metric', () => {
  const listing = {
    id: 'a',
    source: 's',
    url: 'https://x/a',
    price: { rent_net: 2000, total: 2200, extras: 200, currency: 'CHF', deposit_months: 2 },
    rooms: 3,
    area_m2: 70,
    location: { coords: null, address: null, postal_code: null, city: null, region: null, country: 'CH', neighborhood: null },
    enriched: { commute: { work: { transit: { duration_min: 20, distance_km: 6, computed_at: new Date() } } } },
  } as any;

  it('resolves commute primitive to minutes', async () => {
    const score = await scoreListing(
      [{
        type: 'rule', name: 'work', weight: 1,
        metric: { kind: 'commute', target: 'work', mode: 'transit' },
        normalize: { type: 'linear', best: 0, worst: 60, invert: false },
        on_missing: 'zero',
      }],
      listing,
    );
    // linear: 20 between 0 (best=10) and 60 (worst=0) → score 10*(60-20)/60 ≈ 6.667; final = 67
    expect(score.final).toBeGreaterThan(60);
    expect(score.final).toBeLessThan(75);
  });

  it('uses on_missing:zero when target absent', async () => {
    const score = await scoreListing(
      [{
        type: 'rule', name: 'gym', weight: 1,
        metric: { kind: 'commute', target: 'gym', mode: 'transit' },
        normalize: { type: 'linear', best: 0, worst: 60, invert: false },
        on_missing: 'zero',
      }],
      listing,
    );
    expect(score.final).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/core test -- scoring`

- [ ] **Step 4: Extend the metric resolver.**

In `packages/core/src/scoring.ts`, find where `dim.metric` is converted to a number. Wrap it:

```ts
function resolveMetric(metric: string | CommutePrimitive, listing: Listing): number | undefined {
  if (typeof metric === 'object' && metric !== null && 'kind' in metric && metric.kind === 'commute') {
    const cell = listing.enriched?.commute?.[metric.target]?.[metric.mode];
    const val = cell && typeof cell === 'object' ? (cell as Record<string, unknown>).duration_min : undefined;
    return typeof val === 'number' ? val : undefined;
  }
  // existing string/JSONata path resolution stays here
  return existingStringPathResolver(metric as string, listing);
}
```

Import `CommutePrimitive` from `./schemas/dsl.js` at the top of the file.

Replace any existing `dim.metric`-direct access in the per-dimension scoring code with `resolveMetric(dim.metric, listing)`.

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/core test`
Expected: full suite green.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/scoring.ts packages/core/test/scoring.test.ts
git commit -m "core(scoring): resolve commute primitive metric"
```

---

## Task 5: Plugin package scaffold + schemas

**Files:**
- Create: `plugins/enricher-commute/package.json`
- Create: `plugins/enricher-commute/tsconfig.json`
- Create: `plugins/enricher-commute/src/index.ts`
- Create: `plugins/enricher-commute/src/schemas.ts`
- Modify: `packages/server/package.json` (add dependency on the new plugin)
- Modify: root `tsconfig.base.json` if it carries explicit project references (verify first)

- [ ] **Step 1: Create `plugins/enricher-commute/package.json`.**

```json
{
  "name": "@wabe/enricher-commute",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wabe/core": "workspace:*",
    "@wabe/db": "workspace:*",
    "@wabe/plugin-sdk": "workspace:*",
    "p-limit": "^6.1.0",
    "pino": "^9.4.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "better-sqlite3": "^11.3.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `plugins/enricher-commute/tsconfig.json`.**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "references": [
    { "path": "../../packages/core" },
    { "path": "../../packages/db" },
    { "path": "../../packages/plugin-sdk" }
  ],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `plugins/enricher-commute/src/schemas.ts`.**

```ts
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
```

- [ ] **Step 4: Create `plugins/enricher-commute/src/index.ts` (stub plugin).**

```ts
import type { Enricher } from '@wabe/plugin-sdk';
import type { Listing } from '@wabe/core';
import { CommuteConfig } from './schemas.js';

const plugin: Enricher = {
  name: 'enricher-commute',
  configSchema: CommuteConfig,
  async enrich(listing: Listing): Promise<Listing> {
    return listing;
  },
};

export default { kind: 'enricher' as const, plugin };
export { CommuteConfig, CommutePayload } from './schemas.js';
```

- [ ] **Step 5: Add the new plugin to `packages/server/package.json` dependencies.**

Read `packages/server/package.json`, add to `dependencies` block (next to other `@wabe/*` plugin entries):

```json
"@wabe/enricher-commute": "workspace:*"
```

- [ ] **Step 6: Install + build the new package.**

Run: `pnpm install && pnpm --filter @wabe/enricher-commute build`
Expected: clean compile.

- [ ] **Step 7: Commit.**

```bash
git add plugins/enricher-commute packages/server/package.json pnpm-lock.yaml
git commit -m "feat(enricher-commute): package scaffold + Zod config + payload schemas"
```

---

## Task 6: `time.ts` — next-weekday-at helper

**Files:**
- Create: `plugins/enricher-commute/src/time.ts`
- Create: `plugins/enricher-commute/test/time.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// plugins/enricher-commute/test/time.test.ts
import { describe, it, expect } from 'vitest';
import { nextWeekdayAt, hhmmToMin } from '../src/time.js';

describe('hhmmToMin', () => {
  it('parses "08:30" → 510', () => {
    expect(hhmmToMin('08:30')).toBe(510);
  });
  it('parses "00:00" → 0', () => {
    expect(hhmmToMin('00:00')).toBe(0);
  });
  it('parses "23:59" → 1439', () => {
    expect(hhmmToMin('23:59')).toBe(1439);
  });
});

describe('nextWeekdayAt', () => {
  it('returns same-day local datetime when target weekday matches and time has not passed', () => {
    // 2026-05-18 is a Monday
    const now = new Date('2026-05-18T05:00:00');
    const out = nextWeekdayAt('mon', '08:30', now);
    expect(out.getDay()).toBe(1); // Monday
    expect(out.getHours()).toBe(8);
    expect(out.getMinutes()).toBe(30);
    expect(out.toDateString()).toBe(now.toDateString());
  });
  it('rolls forward when current time is past the target hour on the target day', () => {
    // Monday 10:00 → next Monday 08:30
    const now = new Date('2026-05-18T10:00:00');
    const out = nextWeekdayAt('mon', '08:30', now);
    expect(out.getDay()).toBe(1);
    const diffDays = Math.round((out.getTime() - now.getTime()) / 86_400_000);
    expect(diffDays).toBe(7);
  });
  it('finds the next occurrence of a future weekday', () => {
    const now = new Date('2026-05-18T10:00:00'); // Monday
    const out = nextWeekdayAt('thu', '09:00', now);
    expect(out.getDay()).toBe(4); // Thursday
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/enricher-commute test -- time`

- [ ] **Step 3: Implement `time.ts`.**

```ts
// plugins/enricher-commute/src/time.ts
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function nextWeekdayAt(weekday: Weekday, hhmm: string, now: Date = new Date()): Date {
  const target = WEEKDAY_INDEX[weekday];
  const [h, m] = hhmm.split(':').map(Number);
  const out = new Date(now);
  out.setHours(h, m, 0, 0);
  const daysAhead = (target - now.getDay() + 7) % 7;
  if (daysAhead === 0 && out.getTime() <= now.getTime()) {
    out.setDate(out.getDate() + 7);
  } else {
    out.setDate(out.getDate() + daysAhead);
  }
  return out;
}
```

- [ ] **Step 4: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test -- time`

- [ ] **Step 5: Commit.**

```bash
git add plugins/enricher-commute/src/time.ts plugins/enricher-commute/test/time.test.ts
git commit -m "enricher-commute: nextWeekdayAt + hhmmToMin helpers"
```

---

## Task 7: `cache.ts` — better-sqlite3 cache adapter

**Files:**
- Create: `plugins/enricher-commute/src/cache.ts`
- Create: `plugins/enricher-commute/test/cache.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
// plugins/enricher-commute/test/cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommuteCache, quantize, normalizeAddress } from '../src/cache.js';

function freshDb() {
  const db = new Database(':memory:');
  const migrations = ['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql'];
  for (const f of migrations) {
    db.exec(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

describe('quantize', () => {
  it('rounds to N decimals', () => {
    expect(quantize(47.367412345, 4)).toBe(47.3674);
    expect(quantize(8.539987, 4)).toBe(8.54);
  });
});

describe('normalizeAddress', () => {
  it('lowercases + collapses whitespace + trims', () => {
    expect(normalizeAddress('  Brandschenkestrasse 178,  8002   Zürich  ')).toBe('brandschenkestrasse 178, 8002 zürich');
  });
});

describe('CommuteCache', () => {
  let db: ReturnType<typeof freshDb>;
  let cache: CommuteCache;

  beforeEach(() => {
    db = freshDb();
    cache = new CommuteCache(db, 4);
  });

  it('returns undefined on miss', () => {
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });

  it('persists and retrieves a commute row', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date(2026, 4, 18) });
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toMatchObject({ durationS: 1500, distanceM: 8000 });
  });

  it('quantizes coords for cache key', () => {
    cache.upsertCommute({
      from: [47.3674123, 8.5400123], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    const r = cache.getCommute({
      from: [47.3674987, 8.5400987], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r?.durationS).toBe(1500);
  });

  it('different mode → cache miss', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'cycling', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });

  it('persists and retrieves geocode rows', () => {
    cache.upsertGeocode('brandschenkestrasse 178, 8002 zürich', { lat: 47.367, lng: 8.540 }, new Date());
    const r = cache.getGeocode('brandschenkestrasse 178, 8002 zürich');
    expect(r).toMatchObject({ lat: 47.367, lng: 8.540 });
  });

  it('returns undefined for unknown geocode address', () => {
    expect(cache.getGeocode('nope')).toBeUndefined();
  });

  it('clear() empties the commute table', () => {
    cache.upsertCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    }, { durationS: 1500, distanceM: 8000, computedAt: new Date() });
    cache.clear();
    const r = cache.getCommute({
      from: [47.3674, 8.5400], target: 'work', mode: 'transit', weekday: 'mon', arriveByMin: 510,
    });
    expect(r).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/enricher-commute test -- cache`

- [ ] **Step 3: Implement `cache.ts`.**

```ts
// plugins/enricher-commute/src/cache.ts
import type Database from 'better-sqlite3';
import type { CommuteMode } from '@wabe/core';

export type Coord = [number, number]; // [lat, lng]
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface CommuteKey {
  from: Coord;
  target: string;
  mode: CommuteMode;
  weekday: Weekday;
  arriveByMin: number;
}

export interface CommuteRow {
  durationS: number;
  distanceM: number;
  computedAt: Date;
}

export interface GeocodeRow {
  lat: number;
  lng: number;
  computedAt: Date;
}

export function quantize(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function normalizeAddress(addr: string): string {
  return addr.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class CommuteCache {
  constructor(private readonly db: Database.Database, private readonly decimals: number) {}

  getCommute(key: CommuteKey): CommuteRow | undefined {
    const [lat, lng] = key.from;
    const row = this.db
      .prepare(
        `SELECT duration_s, distance_m, computed_at FROM commute_cache
         WHERE from_lat_q = ? AND from_lng_q = ? AND to_target = ? AND mode = ?
           AND weekday = ? AND arrive_by_min = ?`,
      )
      .get(
        quantize(lat, this.decimals),
        quantize(lng, this.decimals),
        key.target,
        key.mode,
        key.weekday,
        key.arriveByMin,
      ) as { duration_s: number; distance_m: number; computed_at: number } | undefined;
    if (!row) return undefined;
    return { durationS: row.duration_s, distanceM: row.distance_m, computedAt: new Date(row.computed_at) };
  }

  upsertCommute(key: CommuteKey, val: CommuteRow): void {
    const [lat, lng] = key.from;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO commute_cache
         (from_lat_q, from_lng_q, to_target, mode, weekday, arrive_by_min, duration_s, distance_m, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        quantize(lat, this.decimals),
        quantize(lng, this.decimals),
        key.target,
        key.mode,
        key.weekday,
        key.arriveByMin,
        val.durationS,
        val.distanceM,
        val.computedAt.getTime(),
      );
  }

  getGeocode(addressNorm: string): GeocodeRow | undefined {
    const row = this.db
      .prepare('SELECT lat, lng, computed_at FROM geocode_cache WHERE address_norm = ?')
      .get(addressNorm) as { lat: number; lng: number; computed_at: number } | undefined;
    if (!row) return undefined;
    return { lat: row.lat, lng: row.lng, computedAt: new Date(row.computed_at) };
  }

  upsertGeocode(addressNorm: string, coords: { lat: number; lng: number }, computedAt: Date): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO geocode_cache (address_norm, lat, lng, computed_at)
         VALUES (?,?,?,?)`,
      )
      .run(addressNorm, coords.lat, coords.lng, computedAt.getTime());
  }

  clear(): void {
    this.db.exec('DELETE FROM commute_cache; DELETE FROM geocode_cache;');
  }
}
```

- [ ] **Step 4: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test -- cache`

- [ ] **Step 5: Commit.**

```bash
git add plugins/enricher-commute/src/cache.ts plugins/enricher-commute/test/cache.test.ts
git commit -m "enricher-commute: SQLite cache (quantize + geocode + commute tables)"
```

---

## Task 8: `geocode.ts` — Pelias adapter

**Files:**
- Create: `plugins/enricher-commute/src/geocode.ts`
- Create: `plugins/enricher-commute/test/geocode.test.ts`
- Create: `plugins/enricher-commute/test/fixtures/pelias-zurich.json`

- [ ] **Step 1: Capture a Pelias fixture.**

Create `plugins/enricher-commute/test/fixtures/pelias-zurich.json`:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [8.5345, 47.3677] },
      "properties": {
        "label": "Brandschenkestrasse 178, 8002 Zürich, Switzerland",
        "confidence": 0.95
      }
    }
  ]
}
```

- [ ] **Step 2: Write failing tests.**

```ts
// plugins/enricher-commute/test/geocode.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geocode, type GeocodeDeps } from '../src/geocode.js';
import { pino } from 'pino';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures/pelias-zurich.json'), 'utf8'));
const logger = pino({ level: 'silent' });

let originalDispatcher: Dispatcher;
let mock: MockAgent;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

function deps(): GeocodeDeps {
  return {
    peliasUrl: 'http://pelias.local',
    timeoutMs: 5000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('geocode', () => {
  it('returns first feature on hit', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*text=.*/, method: 'GET' })
      .reply(200, FIXTURE);
    const out = await geocode('Brandschenkestrasse 178, 8002 Zürich', deps());
    expect(out).toEqual({ lat: 47.3677, lng: 8.5345 });
  });

  it('returns null on empty feature collection', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*/, method: 'GET' })
      .reply(200, { type: 'FeatureCollection', features: [] });
    const out = await geocode('nowhere', deps());
    expect(out).toBeNull();
  });

  it('returns null on 5xx', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*/, method: 'GET' })
      .reply(503, 'down');
    const out = await geocode('Foo', deps());
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/enricher-commute test -- geocode`

- [ ] **Step 4: Implement `geocode.ts`.**

```ts
// plugins/enricher-commute/src/geocode.ts
import { request } from 'undici';
import type { Logger } from 'pino';

export interface GeocodeDeps {
  peliasUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface GeoResult {
  lat: number;
  lng: number;
}

export async function geocode(address: string, deps: GeocodeDeps): Promise<GeoResult | null> {
  const url = `${deps.peliasUrl.replace(/\/$/, '')}/v1/search?text=${encodeURIComponent(address)}&size=1`;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 500) {
      deps.logger.warn({ status: res.statusCode, address }, 'pelias 5xx');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode, address }, 'pelias 4xx');
      return null;
    }
    const body = (await res.body.json()) as {
      features?: { geometry?: { coordinates?: [number, number] } }[];
    };
    const feat = body.features?.[0];
    const coords = feat?.geometry?.coordinates;
    if (!coords) return null;
    return { lng: coords[0], lat: coords[1] };
  } catch (err) {
    deps.logger.warn({ err, address }, 'pelias request failed');
    return null;
  }
}
```

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test -- geocode`

- [ ] **Step 6: Commit.**

```bash
git add plugins/enricher-commute/src/geocode.ts plugins/enricher-commute/test/geocode.test.ts plugins/enricher-commute/test/fixtures/pelias-zurich.json
git commit -m "enricher-commute: Pelias geocoder adapter"
```

---

## Task 9: `route-ors.ts` — ORS car/bike/foot adapter

**Files:**
- Create: `plugins/enricher-commute/src/route-ors.ts`
- Create: `plugins/enricher-commute/test/route-ors.test.ts`
- Create: `plugins/enricher-commute/test/fixtures/ors-cycling.json`

- [ ] **Step 1: Capture an ORS fixture (cycling profile).**

Create `plugins/enricher-commute/test/fixtures/ors-cycling.json`:

```json
{
  "routes": [
    {
      "summary": { "distance": 6234.5, "duration": 1320.7 },
      "segments": [],
      "bbox": [8.5, 47.36, 8.55, 47.39],
      "geometry": "...",
      "way_points": [0, 1]
    }
  ],
  "bbox": [8.5, 47.36, 8.55, 47.39],
  "metadata": {}
}
```

- [ ] **Step 2: Write failing tests.**

```ts
// plugins/enricher-commute/test/route-ors.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOrs, type OrsDeps } from '../src/route-ors.js';
import { pino } from 'pino';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures/ors-cycling.json'), 'utf8'));
const logger = pino({ level: 'silent' });

let originalDispatcher: Dispatcher;
let mock: MockAgent;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

function deps(): OrsDeps {
  return {
    orsUrl: 'http://ors.local',
    timeoutMs: 15000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('routeOrs', () => {
  it('returns duration_s + distance_m for cycling profile', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, FIXTURE);
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.40, 8.55] }, 'cycling', deps());
    expect(out).toEqual({ durationS: Math.round(1320.7), distanceM: Math.round(6234.5) });
  });

  it('maps modes → profiles correctly', async () => {
    for (const [mode, profile] of [
      ['driving', 'driving-car'],
      ['cycling', 'cycling-regular'],
      ['walking', 'foot-walking'],
    ] as const) {
      mock
        .get('http://ors.local')
        .intercept({ path: `/v2/directions/${profile}`, method: 'POST' })
        .reply(200, FIXTURE);
      const out = await routeOrs({ from: [47.37, 8.54], to: [47.40, 8.55] }, mode, deps());
      expect(out).not.toBeNull();
    }
  });

  it('returns null on 5xx', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(503, 'down');
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.40, 8.55] }, 'cycling', deps());
    expect(out).toBeNull();
  });

  it('returns null when no routes in response', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, { routes: [] });
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.40, 8.55] }, 'cycling', deps());
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/enricher-commute test -- route-ors`

- [ ] **Step 4: Implement `route-ors.ts`.**

```ts
// plugins/enricher-commute/src/route-ors.ts
import { request } from 'undici';
import type { Logger } from 'pino';
import type { CommuteMode } from '@wabe/core';

export interface OrsDeps {
  orsUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface RouteResult {
  durationS: number;
  distanceM: number;
}

const PROFILE_MAP: Partial<Record<CommuteMode, string>> = {
  driving: 'driving-car',
  cycling: 'cycling-regular',
  walking: 'foot-walking',
};

export async function routeOrs(
  pts: { from: [number, number]; to: [number, number] }, // [lat, lng]
  mode: CommuteMode,
  deps: OrsDeps,
): Promise<RouteResult | null> {
  const profile = PROFILE_MAP[mode];
  if (!profile) return null;
  const url = `${deps.orsUrl.replace(/\/$/, '')}/v2/directions/${profile}`;
  // ORS uses [lng, lat] order in coordinates.
  const body = JSON.stringify({
    coordinates: [
      [pts.from[1], pts.from[0]],
      [pts.to[1], pts.to[0]],
    ],
  });
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 500) {
      deps.logger.warn({ status: res.statusCode, mode }, 'ors 5xx');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode, mode }, 'ors 4xx');
      return null;
    }
    const j = (await res.body.json()) as { routes?: { summary: { distance: number; duration: number } }[] };
    const r = j.routes?.[0];
    if (!r) return null;
    return { durationS: Math.round(r.summary.duration), distanceM: Math.round(r.summary.distance) };
  } catch (err) {
    deps.logger.warn({ err, mode }, 'ors request failed');
    return null;
  }
}
```

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test -- route-ors`

- [ ] **Step 6: Commit.**

```bash
git add plugins/enricher-commute/src/route-ors.ts plugins/enricher-commute/test/route-ors.test.ts plugins/enricher-commute/test/fixtures/ors-cycling.json
git commit -m "enricher-commute: ORS adapter (car/bike/foot)"
```

---

## Task 10: `route-motis.ts` — Motis PT adapter

**Files:**
- Create: `plugins/enricher-commute/src/route-motis.ts`
- Create: `plugins/enricher-commute/test/route-motis.test.ts`
- Create: `plugins/enricher-commute/test/fixtures/motis-itinerary.json`

- [ ] **Step 1: Capture a Motis fixture.**

Create `plugins/enricher-commute/test/fixtures/motis-itinerary.json`:

```json
{
  "content_type": "RoutingResponse",
  "content": {
    "connections": [
      {
        "stops": [],
        "trips": [],
        "transports": [],
        "attributes": [],
        "free_texts": [],
        "problems": [],
        "night_penalty": 0,
        "db_costs": 0,
        "duration": 1740,
        "transfers": 1,
        "departure": { "time": 1747545300, "schedule_time": 1747545300 },
        "arrival":   { "time": 1747547040, "schedule_time": 1747547040 }
      },
      {
        "duration": 2100,
        "transfers": 0
      }
    ]
  }
}
```

- [ ] **Step 2: Write failing tests.**

```ts
// plugins/enricher-commute/test/route-motis.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeMotis, type MotisDeps } from '../src/route-motis.js';
import { pino } from 'pino';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures/motis-itinerary.json'), 'utf8'));
const logger = pino({ level: 'silent' });

let originalDispatcher: Dispatcher;
let mock: MockAgent;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

function deps(): MotisDeps {
  return {
    motisUrl: 'http://motis.local',
    timeoutMs: 15000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('routeMotis', () => {
  it('picks the fastest connection', async () => {
    mock
      .get('http://motis.local')
      .intercept({ path: '/api/v1/plan', method: 'POST' })
      .reply(200, FIXTURE);
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.40, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toEqual({ durationS: 1740, distanceM: 0 });
  });

  it('returns null when no connections', async () => {
    mock
      .get('http://motis.local')
      .intercept({ path: '/api/v1/plan', method: 'POST' })
      .reply(200, { content_type: 'RoutingResponse', content: { connections: [] } });
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.40, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toBeNull();
  });

  it('returns null on 5xx', async () => {
    mock
      .get('http://motis.local')
      .intercept({ path: '/api/v1/plan', method: 'POST' })
      .reply(503, 'down');
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.40, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL.**

Run: `pnpm --filter @wabe/enricher-commute test -- route-motis`

- [ ] **Step 4: Implement `route-motis.ts`.**

```ts
// plugins/enricher-commute/src/route-motis.ts
import { request } from 'undici';
import type { Logger } from 'pino';
import type { RouteResult } from './route-ors.js';

export interface MotisDeps {
  motisUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export async function routeMotis(
  pts: { from: [number, number]; to: [number, number] }, // [lat, lng]
  arriveBy: Date,
  deps: MotisDeps,
): Promise<RouteResult | null> {
  const url = `${deps.motisUrl.replace(/\/$/, '')}/api/v1/plan`;
  const body = JSON.stringify({
    start: { lat: pts.from[0], lng: pts.from[1] },
    destination: { lat: pts.to[0], lng: pts.to[1] },
    interval: { begin: Math.floor(arriveBy.getTime() / 1000) - 3600, end: Math.floor(arriveBy.getTime() / 1000) },
    arriveBy: true,
  });
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 500) {
      deps.logger.warn({ status: res.statusCode }, 'motis 5xx');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode }, 'motis 4xx');
      return null;
    }
    const j = (await res.body.json()) as { content?: { connections?: { duration: number }[] } };
    const conns = j.content?.connections ?? [];
    if (conns.length === 0) return null;
    const fastest = conns.reduce((a, b) => (a.duration <= b.duration ? a : b));
    return { durationS: fastest.duration, distanceM: 0 }; // Motis itinerary distance not directly exposed
  } catch (err) {
    deps.logger.warn({ err }, 'motis request failed');
    return null;
  }
}
```

- [ ] **Step 5: Re-run tests — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test -- route-motis`

- [ ] **Step 6: Commit.**

```bash
git add plugins/enricher-commute/src/route-motis.ts plugins/enricher-commute/test/route-motis.test.ts plugins/enricher-commute/test/fixtures/motis-itinerary.json
git commit -m "enricher-commute: Motis transit adapter (fastest itinerary)"
```

---

## Task 11: `enrich.ts` — orchestration + integration test

**Files:**
- Create: `plugins/enricher-commute/src/enrich.ts`
- Modify: `plugins/enricher-commute/src/index.ts` (wire orchestration)
- Create: `plugins/enricher-commute/test/enrich.integration.test.ts`

- [ ] **Step 1: Write the integration test.**

```ts
// plugins/enricher-commute/test/enrich.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { enrichCommute } from '../src/enrich.js';
import type { CommuteConfig } from '../src/schemas.js';

const logger = pino({ level: 'silent' });
const ORS = JSON.parse(readFileSync(join(__dirname, 'fixtures/ors-cycling.json'), 'utf8'));
const MOTIS = JSON.parse(readFileSync(join(__dirname, 'fixtures/motis-itinerary.json'), 'utf8'));
const PELIAS = JSON.parse(readFileSync(join(__dirname, 'fixtures/pelias-zurich.json'), 'utf8'));

function freshDb() {
  const db = new Database(':memory:');
  for (const f of ['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql']) {
    db.exec(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

let originalDispatcher: Dispatcher;
let mock: MockAgent;
beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(() => setGlobalDispatcher(originalDispatcher));

const cfg: CommuteConfig = {
  endpoints: {
    ors_url: 'http://ors.local',
    motis_url: 'http://motis.local',
    pelias_url: 'http://pelias.local',
  },
  targets: {
    work: {
      coords: [8.5395, 47.3681],
      arrive_by: '08:30',
      weekday: 'mon',
      modes: ['transit', 'cycling'],
    },
  },
  cache: { enabled: true, quantize_decimals: 4 },
  timeouts: { geocode_ms: 5000, route_ms: 15000 },
};

const listingWithCoords = {
  id: 'a', source: 's', url: 'https://x/a',
  first_seen_at: new Date(), last_seen_at: new Date(),
  price: { rent_net: null, total: null, extras: null, currency: 'CHF', deposit_months: null },
  rooms: null, area_m2: null, floor: null, total_floors: null, built_year: null, renovated_year: null,
  location: {
    coords: [8.54, 47.37] as [number, number],
    address: null, postal_code: null, city: null, region: null, country: 'CH', neighborhood: null,
  },
  features: {}, description: null, photos: [], available_from: null, lease_until: null,
  rental_term: 'unknown' as const, agency: null, contact: {}, enriched: {}, extra: {},
  canonical_key: '', source_priority: 50, seen_on_sources: [],
};

describe('enrichCommute', () => {
  it('populates enriched.commute for both modes', async () => {
    const db = freshDb();
    mock.get('http://ors.local').intercept({ path: '/v2/directions/cycling-regular', method: 'POST' }).reply(200, ORS);
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    const out = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    expect(out.enriched.commute).toBeDefined();
    const work = (out.enriched.commute as Record<string, Record<string, { duration_min: number }>>).work;
    expect(work.cycling.duration_min).toBe(22);   // 1320.7s → 22min
    expect(work.transit.duration_min).toBe(29);   // 1740s → 29min
  });

  it('omits failed mode but keeps the rest', async () => {
    const db = freshDb();
    mock.get('http://ors.local').intercept({ path: '/v2/directions/cycling-regular', method: 'POST' }).reply(503, 'down');
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    const out = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    const work = (out.enriched.commute as Record<string, Record<string, unknown>>).work;
    expect(work.cycling).toBeUndefined();
    expect(work.transit).toBeDefined();
  });

  it('returns listing unchanged when listing has no coords and pelias fails', async () => {
    const db = freshDb();
    const noCoords = { ...listingWithCoords, location: { ...listingWithCoords.location, coords: null, address: 'X' } };
    mock.get('http://pelias.local').intercept({ path: /\/v1\/search\?.*/, method: 'GET' }).reply(503, 'down');
    const out = await enrichCommute(noCoords, cfg, db, logger, new AbortController().signal);
    expect(out.enriched.commute).toBeUndefined();
  });

  it('hits cache on second call (no HTTP traffic)', async () => {
    const db = freshDb();
    mock.get('http://ors.local').intercept({ path: '/v2/directions/cycling-regular', method: 'POST' }).reply(200, ORS);
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    // Second call — no new MockAgent interceptors registered → would throw on HTTP attempt.
    const out2 = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    const work = (out2.enriched.commute as Record<string, Record<string, { duration_min: number }>>).work;
    expect(work.cycling.duration_min).toBe(22);
    expect(work.transit.duration_min).toBe(29);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL ("enrichCommute not defined").**

Run: `pnpm --filter @wabe/enricher-commute test -- enrich.integration`

- [ ] **Step 3: Implement `enrich.ts`.**

```ts
// plugins/enricher-commute/src/enrich.ts
import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { Listing, CommuteMode } from '@wabe/core';
import { Listing as ListingSchema } from '@wabe/core';
import pLimit from 'p-limit';
import type { CommuteConfig } from './schemas.js';
import { CommuteCache, normalizeAddress, type Coord } from './cache.js';
import { geocode } from './geocode.js';
import { routeOrs } from './route-ors.js';
import { routeMotis } from './route-motis.js';
import { hhmmToMin, nextWeekdayAt } from './time.js';

type TargetCoords = Map<string, Coord>; // target id → [lat, lng]

async function resolveTargetCoords(cfg: CommuteConfig, cache: CommuteCache, logger: Logger, signal: AbortSignal): Promise<TargetCoords> {
  const out: TargetCoords = new Map();
  for (const [id, t] of Object.entries(cfg.targets)) {
    if (t.coords) {
      out.set(id, [t.coords[1], t.coords[0]]); // user coords are [lng, lat] → store [lat, lng]
      continue;
    }
    const norm = normalizeAddress(t.address!);
    const cached = cache.getGeocode(norm);
    if (cached) {
      out.set(id, [cached.lat, cached.lng]);
      continue;
    }
    const r = await geocode(t.address!, {
      peliasUrl: cfg.endpoints.pelias_url,
      timeoutMs: cfg.timeouts.geocode_ms,
      logger,
      signal,
    });
    if (!r) {
      logger.warn({ target: id }, 'target geocode failed; skipping target this run');
      continue;
    }
    cache.upsertGeocode(norm, r, new Date());
    out.set(id, [r.lat, r.lng]);
  }
  return out;
}

async function resolveListingCoords(listing: Listing, cfg: CommuteConfig, cache: CommuteCache, logger: Logger, signal: AbortSignal): Promise<Coord | null> {
  if (listing.location.coords) return [listing.location.coords[1], listing.location.coords[0]]; // [lng,lat] → [lat,lng]
  const addr = [listing.location.address, listing.location.postal_code, listing.location.city]
    .filter(Boolean)
    .join(', ');
  if (!addr) return null;
  const norm = normalizeAddress(addr);
  const cached = cache.getGeocode(norm);
  if (cached) return [cached.lat, cached.lng];
  const r = await geocode(addr, {
    peliasUrl: cfg.endpoints.pelias_url,
    timeoutMs: cfg.timeouts.geocode_ms,
    logger,
    signal,
  });
  if (!r) return null;
  cache.upsertGeocode(norm, r, new Date());
  return [r.lat, r.lng];
}

async function computeOne(
  from: Coord,
  to: Coord,
  targetId: string,
  mode: CommuteMode,
  weekday: CommuteConfig['targets'][string]['weekday'],
  arriveByHHMM: string,
  cfg: CommuteConfig,
  cache: CommuteCache,
  logger: Logger,
  signal: AbortSignal,
): Promise<{ durationS: number; distanceM: number } | null> {
  const arriveByMin = hhmmToMin(arriveByHHMM);
  const key = { from, target: targetId, mode, weekday, arriveByMin };
  if (cfg.cache.enabled) {
    const hit = cache.getCommute(key);
    if (hit) return { durationS: hit.durationS, distanceM: hit.distanceM };
  }
  let r: { durationS: number; distanceM: number } | null;
  if (mode === 'transit') {
    const at = nextWeekdayAt(weekday, arriveByHHMM);
    r = await routeMotis({ from, to }, at, {
      motisUrl: cfg.endpoints.motis_url,
      timeoutMs: cfg.timeouts.route_ms,
      logger,
      signal,
    });
  } else {
    r = await routeOrs({ from, to }, mode, {
      orsUrl: cfg.endpoints.ors_url,
      timeoutMs: cfg.timeouts.route_ms,
      logger,
      signal,
    });
  }
  if (!r) return null;
  if (cfg.cache.enabled) cache.upsertCommute(key, { ...r, computedAt: new Date() });
  return r;
}

export async function enrichCommute(
  listing: Listing,
  cfg: CommuteConfig,
  db: Database.Database,
  logger: Logger,
  signal: AbortSignal,
): Promise<Listing> {
  const cache = new CommuteCache(db, cfg.cache.quantize_decimals);
  const targetCoords = await resolveTargetCoords(cfg, cache, logger, signal);
  const listingCoords = await resolveListingCoords(listing, cfg, cache, logger, signal);
  if (!listingCoords) {
    logger.warn({ listing_id: listing.id }, 'listing coords unresolved; skipping commute enrich');
    return listing;
  }

  const limit = pLimit(4);
  const result: Record<string, Record<string, { duration_min: number; distance_km: number; computed_at: Date }>> = {};

  const jobs: Promise<void>[] = [];
  for (const [tid, t] of Object.entries(cfg.targets)) {
    const to = targetCoords.get(tid);
    if (!to) continue;
    for (const mode of t.modes) {
      jobs.push(
        limit(async () => {
          const r = await computeOne(listingCoords, to, tid, mode, t.weekday, t.arrive_by, cfg, cache, logger, signal);
          if (!r) return;
          result[tid] ??= {};
          result[tid][mode] = {
            duration_min: Math.round(r.durationS / 60),
            distance_km: r.distanceM / 1000,
            computed_at: new Date(),
          };
        }),
      );
    }
  }
  await Promise.all(jobs);

  if (Object.keys(result).length === 0) return listing;

  return ListingSchema.parse({
    ...listing,
    enriched: { ...listing.enriched, commute: result },
  });
}
```

- [ ] **Step 4: Wire `enrich.ts` into `index.ts`.**

Replace `plugins/enricher-commute/src/index.ts` body:

```ts
import type { Enricher } from '@wabe/plugin-sdk';
import type { Listing } from '@wabe/core';
import type { WabeDb } from '@wabe/db';
import { CommuteConfig } from './schemas.js';
import { enrichCommute } from './enrich.js';

const plugin: Enricher = {
  name: 'enricher-commute',
  configSchema: CommuteConfig,
  async enrich(listing: Listing, ctx): Promise<Listing> {
    const cfg = CommuteConfig.parse(ctx.config);
    return enrichCommute(listing, cfg, (ctx.db as WabeDb)._raw, ctx.logger, ctx.signal);
  },
};

export default { kind: 'enricher' as const, plugin };
export { CommuteConfig, CommutePayload } from './schemas.js';
```

- [ ] **Step 5: Re-run integration test — expect PASS.**

Run: `pnpm --filter @wabe/enricher-commute test`
Expected: all tests in the package pass.

- [ ] **Step 6: Typecheck.**

Run: `pnpm --filter @wabe/enricher-commute typecheck`

- [ ] **Step 7: Commit.**

```bash
git add plugins/enricher-commute/src/enrich.ts plugins/enricher-commute/src/index.ts plugins/enricher-commute/test/enrich.integration.test.ts
git commit -m "enricher-commute: orchestration (geocode + routing + cache + p-limit)"
```

---

## Task 12: Pipeline wiring — enricher stage in `@wabe/server`

**Files:**
- Modify: `packages/server/src/pipeline.ts`
- Create: `packages/server/test/pipeline-enrich.integration.test.ts`

- [ ] **Step 1: Write a failing integration test using a stub enricher.**

```ts
// packages/server/test/pipeline-enrich.integration.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { runOnce } from '../src/pipeline.js';
import type { LoadedPlugin } from '../src/loader.js';
import type { Source, Enricher, Notifier } from '@wabe/plugin-sdk';

function freshDb() {
  const db = new Database(':memory:');
  for (const f of ['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql']) {
    db.exec(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', f), 'utf8'));
  }
  return { _raw: db } as any;
}

const stubSource: Source = {
  name: 'stub',
  configSchema: { parse: (x: unknown) => x } as any,
  async *fetch() {
    yield {
      id: 'stub:1', source: 'stub', url: 'https://example.com/1',
      price: { rent_net: 2000, total: 2200, extras: 200, currency: 'CHF', deposit_months: 2 },
      rooms: 3, area_m2: 70,
      location: { coords: [8.54, 47.37], address: null, postal_code: '8002', city: 'Zürich', region: null, country: 'CH', neighborhood: null },
      enriched: {},
    } as any;
  },
};

const stubEnricher: Enricher = {
  name: 'stub-enricher',
  configSchema: { parse: (x: unknown) => x } as any,
  async enrich(listing) {
    return { ...listing, enriched: { ...listing.enriched, marker: 'hit' } };
  },
};

const noopNotifier: Notifier = {
  name: 'noop',
  configSchema: { parse: (x: unknown) => x } as any,
  async send() {},
};

describe('pipeline enricher stage', () => {
  it('runs loaded enrichers and persists the post-enrich payload', async () => {
    const db = freshDb();
    const sources: LoadedPlugin<'source'>[] = [{ name: 'stub', plugin: stubSource, config: {} } as any];
    const enrichers: LoadedPlugin<'enricher'>[] = [{ name: 'stub-enricher', plugin: stubEnricher, config: {} } as any];
    const notifiers: LoadedPlugin<'notifier'>[] = [{ name: 'noop', plugin: noopNotifier, config: {} } as any];

    await runOnce({
      cfg: {
        filters: { filters: [] },
        scoring: { scoring: [], notify: { threshold: 0, daily_quota: 100 } },
        rentalTerm: { mode: 'long', exclude_unknown: false },
        top: {},
      } as any,
      db,
      logger: pino({ level: 'silent' }),
      signal: new AbortController().signal,
      sources,
      enrichers,
      notifiers,
      breakers: new Map(),
      quota: { tryConsume: () => true, remaining: () => 100 } as any,
    });

    const row = db._raw.prepare('SELECT payload FROM listings WHERE id = ?').get('stub:1') as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.enriched.marker).toBe('hit');
  });

  it('continues when one enricher throws', async () => {
    const throwingEnricher: Enricher = {
      name: 'throwing',
      configSchema: { parse: (x: unknown) => x } as any,
      async enrich() { throw new Error('boom'); },
    };
    const db = freshDb();
    const sources: LoadedPlugin<'source'>[] = [{ name: 'stub', plugin: stubSource, config: {} } as any];
    const enrichers: LoadedPlugin<'enricher'>[] = [
      { name: 'throwing', plugin: throwingEnricher, config: {} } as any,
      { name: 'stub-enricher', plugin: stubEnricher, config: {} } as any,
    ];
    const notifiers: LoadedPlugin<'notifier'>[] = [{ name: 'noop', plugin: noopNotifier, config: {} } as any];

    await runOnce({
      cfg: {
        filters: { filters: [] },
        scoring: { scoring: [], notify: { threshold: 0, daily_quota: 100 } },
        rentalTerm: { mode: 'long', exclude_unknown: false },
        top: {},
      } as any,
      db,
      logger: pino({ level: 'silent' }),
      signal: new AbortController().signal,
      sources,
      enrichers,
      notifiers,
      breakers: new Map(),
      quota: { tryConsume: () => true, remaining: () => 100 } as any,
    });

    const row = db._raw.prepare('SELECT payload FROM listings WHERE id = ?').get('stub:1') as { payload: string } | undefined;
    const payload = JSON.parse(row!.payload);
    expect(payload.enriched.marker).toBe('hit'); // second enricher still ran
  });
});
```

- [ ] **Step 2: Run test — expect FAIL.**

Run: `pnpm --filter @wabe/server test -- pipeline-enrich`
Expected: FAIL — enrichers not invoked.

- [ ] **Step 3: Extend `RunOptions` in `pipeline.ts`.**

In `packages/server/src/pipeline.ts`:

- Add to imports: `import { upsertListing } from './dedupe.js';` (likely already imported — verify).
- Extend `RunOptions`:

```ts
export interface RunOptions {
  cfg: LoadedConfig;
  db: WabeDb;
  logger: Logger;
  signal: AbortSignal;
  sources: LoadedPlugin<'source'>[];
  enrichers: LoadedPlugin<'enricher'>[];     // NEW
  notifiers: LoadedPlugin<'notifier'>[];
  breakers: Map<string, CircuitBreaker>;
  quota: Quota;
}
```

- Update `runOnce` to forward enrichers (no code change needed if it passes opts wholesale to `runSource`).

- [ ] **Step 4: Insert enricher stage in `runSource`.**

In `runSource`, find the line `const enriched: Listing = Listing.parse({ ... });`. Rename the local `enriched` variable to `parsed` to avoid shadowing the upcoming enricher loop. Update the immediately-following `const { changed, isNew } = upsertListing(opts.db, enriched);` to use `parsed`. The mechanical rename:

```ts
const parsed: Listing = Listing.parse({
  ...raw,
  id: raw.id ?? `${raw.source}:unknown:${Date.now()}`,
  first_seen_at: raw.first_seen_at ?? new Date(),
  last_seen_at: raw.last_seen_at ?? new Date(),
  canonical_key: ck,
  source_priority: priority,
});
const { changed, isNew } = upsertListing(opts.db, parsed);
if (!changed) continue;

// --- enricher stage (new) ---
let current: Listing = parsed;
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
      upsertListing(opts.db, current);
    }
  } catch (err) {
    log.warn({ err, enricher: e.plugin.name, listing_id: current.id }, 'enricher failed; continuing');
  }
}
// --- end enricher stage ---

const termVerdict = rentalTermPasses(current, opts.cfg.rentalTerm);
```

Then replace every subsequent reference to the old `enriched` variable inside the `runSource` body (the `evaluateFilters(...)`, `scoreListing(...)`, `shouldNotify(...)`, INSERT INTO scores, notify event, log lines) to use `current` instead.

- [ ] **Step 5: Update the caller in `runOnce` and any other entry point.**

Check `packages/server/src/index.ts` (or wherever `runOnce` is called by `wabe scan` / `wabe start`):

Run: `grep -rn "runOnce\\|RunOptions" packages/server/src packages/cli/src`

For each caller, pass `enrichers: plugins.enrichers` alongside the existing `sources` / `notifiers`.

- [ ] **Step 6: Re-run test — expect PASS.**

Run: `pnpm --filter @wabe/server test -- pipeline-enrich`

- [ ] **Step 7: Run the full server test suite.**

Run: `pnpm --filter @wabe/server test`
Expected: all tests pass; existing integration tests adapt to the new `enrichers: []` field (add it as `[]` where missing).

- [ ] **Step 8: Commit.**

```bash
git add packages/server/src/pipeline.ts packages/server/test/pipeline-enrich.integration.test.ts
git commit -m "server(pipeline): invoke enricher stage between upsert and rental-term gate"
```

---

## Task 13: CLI — `wabe cache clear --commute`

**Files:**
- Create: `packages/cli/src/commands/cache.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Implement the command.**

Create `packages/cli/src/commands/cache.ts`:

```ts
import { Command } from 'commander';
import { openDb } from '@wabe/db';
import { resolveDataDir } from '../paths.js'; // existing helper

export function registerCache(program: Command): void {
  const cache = program.command('cache').description('Cache utilities');

  cache
    .command('clear')
    .description('Clear cached enricher data')
    .option('--commute', 'Clear commute + geocode cache')
    .action(async (opts: { commute?: boolean }) => {
      if (!opts.commute) {
        console.error('Specify what to clear, e.g. --commute');
        process.exit(2);
      }
      const db = openDb(resolveDataDir());
      db._raw.exec('DELETE FROM commute_cache; DELETE FROM geocode_cache;');
      console.log('Cleared commute_cache + geocode_cache.');
      db._raw.close();
    });
}
```

- [ ] **Step 2: Register the command.**

In `packages/cli/src/index.ts`, alongside other `registerXxx(program)` calls:

```ts
import { registerCache } from './commands/cache.js';
// ...
registerCache(program);
```

- [ ] **Step 3: Smoke-test the command.**

Run: `pnpm --filter @wabe/cli build && pnpm wabe cache clear --commute`
Expected: exit 0, message printed. (Run after Task 1's migration is also applied to the local data dir.)

- [ ] **Step 4: Commit.**

```bash
git add packages/cli/src/commands/cache.ts packages/cli/src/index.ts
git commit -m "cli: wabe cache clear --commute"
```

---

## Task 14: Doctor probe — commute endpoints

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Read the current doctor structure to find the right insertion point.**

Run: `grep -n "bridge\\|probe\\|fetch" packages/cli/src/commands/doctor.ts`

- [ ] **Step 2: Add probe helpers + call sites.**

Append a `probeCommute()` helper to `doctor.ts`:

```ts
async function probeCommute(commuteCfgPath: string | null, logger: Logger): Promise<void> {
  if (!commuteCfgPath) {
    console.log('[--] commute            — disabled (no enricher-commute in config)');
    return;
  }
  // load commute.yaml; for each endpoint, GET /health (or /v1/search for pelias) with short timeout.
  let cfg: { endpoints: { ors_url: string; motis_url: string; pelias_url: string } };
  try {
    cfg = parseYaml(readFileSync(commuteCfgPath, 'utf8'));
  } catch (err) {
    console.log(`[FAIL] commute            — config parse failed: ${(err as Error).message}`);
    return;
  }
  for (const [name, url] of [
    ['commute-ors', `${cfg.endpoints.ors_url.replace(/\/$/, '')}/v2/health`],
    ['commute-motis', `${cfg.endpoints.motis_url.replace(/\/$/, '')}/`],
    ['commute-pelias', `${cfg.endpoints.pelias_url.replace(/\/$/, '')}/v1/status`],
  ] as const) {
    try {
      const res = await request(url, { headersTimeout: 2000, bodyTimeout: 2000 });
      console.log(res.statusCode < 500 ? `[OK ] ${name.padEnd(20)} — ${res.statusCode}` : `[WARN] ${name.padEnd(20)} — ${res.statusCode}`);
    } catch (err) {
      console.log(`[WARN] ${name.padEnd(20)} — unreachable: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 3: Wire the probe into the existing doctor sequence.**

In the body of the existing doctor `action`, after the bridge probe, locate the commute enricher's config path from the loaded config (`cfg.top.enabled.enrichers.find(e => e.name === 'enricher-commute')?.config_path`) and pass it to `probeCommute(commuteCfgPath, logger)`.

- [ ] **Step 4: Smoke test.**

Run: `pnpm --filter @wabe/cli build && pnpm wabe doctor`
Expected: prints `[OK]` / `[WARN]` lines for the three commute endpoints when enricher-commute is enabled; prints `[--] commute — disabled` when not.

- [ ] **Step 5: Commit.**

```bash
git add packages/cli/src/commands/doctor.ts
git commit -m "cli(doctor): probe commute endpoints (ORS + Motis + Pelias)"
```

---

## Task 15: Docker compose recipe

**Files:**
- Create: `docker/commute/compose.yml`
- Create: `docker/commute/README.md`
- Create: `docker/commute/Makefile`
- Create: `docker/commute/ors-config.yml.example`
- Create: `docker/commute/pelias-config.json.example`
- Create: `docker/commute/.gitignore`

- [ ] **Step 1: Create `compose.yml`.**

```yaml
services:
  ors:
    image: openrouteservice/openrouteservice:v8.0.0
    ports:
      - "8080:8080"
    volumes:
      - ./ors-data:/home/ors/files
      - ./ors-config.yml:/home/ors/ors-config.yml:ro
    environment:
      ORS_CONFIG_LOCATION: /home/ors/ors-config.yml
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8080/ors/v2/health"]
      interval: 30s
      timeout: 5s
      retries: 5

  motis:
    image: ghcr.io/motis-project/motis:latest
    ports:
      - "8081:8080"
    volumes:
      - ./motis-data:/data
    command: ["server", "--config", "/data/config.ini"]
    restart: unless-stopped

  pelias-elasticsearch:
    image: pelias/elasticsearch:7.16.3
    volumes:
      - ./pelias-es-data:/usr/share/elasticsearch/data
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ulimits:
      memlock: { soft: -1, hard: -1 }
    restart: unless-stopped

  pelias:
    image: pelias/api:latest
    ports:
      - "4000:4000"
    volumes:
      - ./pelias-config.json:/code/pelias.json:ro
    depends_on:
      - pelias-elasticsearch
    restart: unless-stopped
```

- [ ] **Step 2: Create `Makefile`.**

```makefile
.PHONY: data data-osm data-gtfs data-pelias up down logs health refresh-gtfs

OSM_URL = https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
GTFS_URL = https://opentransportdata.swiss/dataset/timetable-gtfs.zip

data: data-osm data-gtfs data-pelias

data-osm:
	mkdir -p ors-data motis-data
	curl -L -o ors-data/switzerland-latest.osm.pbf $(OSM_URL)
	cp ors-data/switzerland-latest.osm.pbf motis-data/

data-gtfs:
	mkdir -p motis-data
	curl -L -o motis-data/gtfs.zip $(GTFS_URL)

data-pelias:
	@echo "Pelias indexing: run the standard pelias importers against your ES instance."
	@echo "See https://github.com/pelias/docker for the full openaddresses + OSM + WhosOnFirst flow."

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

health:
	@curl -fsS http://localhost:8080/ors/v2/health && echo " ORS ok"
	@curl -fsS http://localhost:8081/ && echo " Motis ok"
	@curl -fsS http://localhost:4000/v1/status && echo " Pelias ok"

refresh-gtfs: data-gtfs
	docker compose restart motis
```

- [ ] **Step 3: Create `README.md`.**

```markdown
# Self-hosted commute routing stack

Three services backing `@wabe/enricher-commute`:

| Service | Port | Role |
|---------|------|------|
| ORS     | 8080 | Car / bike / foot routing |
| Motis   | 8081 | Public-transit routing (transitous-compatible) |
| Pelias  | 4000 | Geocoding |

## One-off setup

1. `make data` — downloads CH OSM extract from Geofabrik and SBB GTFS from opentransportdata.swiss into `./ors-data/`, `./motis-data/`, etc. Disk: ~4 GB.
2. Copy `ors-config.yml.example` → `ors-config.yml`. Adjust profiles if desired (defaults: car / bike / foot enabled).
3. Copy `pelias-config.json.example` → `pelias-config.json`. Run the Pelias importers (separate one-off — see `data-pelias` target output for guidance).
4. `make up` — start all three.
5. `make health` — curl each endpoint.

## Maintenance

- `make refresh-gtfs` — re-pull SBB GTFS and restart Motis. CH timetables change semi-annually.
- `make down` / `make logs` — standard compose ops.

## Notes

- All data under `./*-data/` is gitignored.
- The Wabe daemon expects these endpoints at the URLs in `commute.yaml`. Pair-default values match this compose file.
- `wabe doctor` probes `/v2/health`, `/`, `/v1/status` respectively.
```

- [ ] **Step 4: Create example configs + .gitignore.**

`docker/commute/ors-config.yml.example`:

```yaml
ors:
  engine:
    profile_default:
      build:
        source_file: /home/ors/files/switzerland-latest.osm.pbf
    profiles:
      driving-car: { enabled: true }
      cycling-regular: { enabled: true }
      foot-walking: { enabled: true }
  endpoints:
    routing: { enabled: true }
  cors:
    allowed_origins: "*"
```

`docker/commute/pelias-config.json.example`:

```json
{
  "logger": { "level": "info" },
  "esclient": { "apiVersion": "7.16", "hosts": [{ "host": "pelias-elasticsearch" }] },
  "api": { "host": "0.0.0.0", "port": 4000 },
  "imports": {
    "openstreetmap": { "datapath": "/data/openstreetmap", "leveldbpath": "/tmp" },
    "openaddresses": { "datapath": "/data/openaddresses", "files": [] }
  }
}
```

`docker/commute/.gitignore`:

```
ors-data/
motis-data/
pelias-es-data/
ors-config.yml
pelias-config.json
```

- [ ] **Step 5: Commit.**

```bash
git add docker/commute
git commit -m "docker: self-hosted commute stack (ORS + Motis + Pelias)"
```

---

## Task 16: Example config + zurich-family wiring

**Files:**
- Create: `examples/zurich-family/commute.yaml`
- Modify: `examples/zurich-family/config.yaml`
- Modify: `examples/zurich-family/scoring.yaml`
- Modify: `examples/zurich-family/filters.yaml`

- [ ] **Step 1: Create `examples/zurich-family/commute.yaml`.**

```yaml
endpoints:
  ors_url: http://localhost:8080/ors
  motis_url: http://localhost:8081
  pelias_url: http://localhost:4000

targets:
  work:
    address: "Brandschenkestrasse 178, 8002 Zürich"
    arrive_by: "08:30"
    weekday: mon
    modes: [transit, cycling, walking]
  partner-work:
    address: "Bahnhofstrasse 1, 8001 Zürich"
    arrive_by: "09:00"
    weekday: mon
    modes: [transit]

cache:
  enabled: true
  quantize_decimals: 4

timeouts:
  geocode_ms: 5000
  route_ms: 15000
```

- [ ] **Step 2: Enable enricher in `config.yaml`.**

Read the file, then in the `enabled.enrichers` section append:

```yaml
    - name: enricher-commute
      config_path: ./commute.yaml
```

- [ ] **Step 3: Add commute rule to `scoring.yaml`.**

Append (under the existing `scoring:` list):

```yaml
  - type: rule
    name: commute-work
    weight: 0.4
    metric: { kind: commute, target: work, mode: transit }
    normalize: { type: linear, best: 0, worst: 60, invert: false }
    on_missing: zero
  - type: rule
    name: commute-partner
    weight: 0.2
    metric: { kind: commute, target: partner-work, mode: transit }
    normalize: { type: linear, best: 0, worst: 70, invert: false }
    on_missing: zero
```

- [ ] **Step 4: Add commute filter to `filters.yaml`.**

Append:

```yaml
  - kind: commute
    target: work
    mode: transit
    op: <=
    value: 45
    on_missing: pass
```

- [ ] **Step 5: Run the example-gate test.**

Run: `pnpm --filter @wabe-example/zurich-family test`
Expected: PASS — example configs validate against the schemas.

- [ ] **Step 6: Commit.**

```bash
git add examples/zurich-family
git commit -m "examples: enable enricher-commute in zurich-family"
```

---

## Task 17: README + plugin README updates

**Files:**
- Create: `plugins/enricher-commute/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write `plugins/enricher-commute/README.md`.**

```markdown
# @wabe/enricher-commute

First-party `Enricher` plugin: computes per-target × per-mode commute time and writes it to `listing.enriched.commute`.

## What it does

For each listing:

1. Resolve listing coordinates — use `location.coords` if present, otherwise geocode `address + postal + city` via Pelias (cached).
2. For each target in `commute.yaml`, for each requested mode (`transit` / `cycling` / `walking` / `driving`), compute travel duration:
   - Transit → Motis (`/api/v1/plan`, arriveBy).
   - Car / bike / foot → ORS (`/v2/directions/{profile}`).
3. Cache results in `commute_cache` (quantized coords + target + mode + weekday + arrive-by). Infinite TTL.
4. Write `enriched.commute[target][mode] = { duration_min, distance_km, computed_at }`.

Failures are best-effort: a failed mode / target is omitted; the listing always proceeds.

## Config (`commute.yaml`)

See the example in `examples/zurich-family/commute.yaml`. Minimum:

```yaml
endpoints:
  ors_url: http://localhost:8080/ors
  motis_url: http://localhost:8081
  pelias_url: http://localhost:4000

targets:
  work:
    address: "Brandschenkestrasse 178, 8002 Zürich"
    arrive_by: "08:30"
    weekday: mon
    modes: [transit, cycling]
```

## Consuming in filters / scoring

```yaml
# filters.yaml
- kind: commute
  target: work
  mode: transit
  op: <=
  value: 30

# scoring.yaml
- type: rule
  name: commute-work
  weight: 0.4
  metric: { kind: commute, target: work, mode: transit }
  normalize: { type: linear, best: 0, worst: 60 }
  on_missing: zero
```

Missing target / mode evaluates to `Infinity`; `linear` normalization treats it as `worst`; `on_missing: zero` makes the dimension contribute 0.

## Self-hosted infra

See `docker/commute/` for the ORS + Motis + Pelias compose recipe.

## Invalidation

`wabe cache clear --commute` truncates both the commute and geocode caches.
```

- [ ] **Step 2: Update root `README.md`.**

Under the existing roadmap / "Subsequent shipped milestones" list, append:

```markdown
- **Enricher stage shipped.** Pipeline now invokes enrichers between upsert and the rental-term gate. First enricher: `@wabe/enricher-commute` — per-target × per-mode commute time via self-hosted ORS + Motis + Pelias, results consumable by filters and scoring through a new `commute(target, mode)` DSL primitive. Docker compose recipe in `docker/commute/`.
```

In the Architecture diagram, replace the existing pipeline diagram block with:

```
config.yaml + commute.yaml + agencies.yaml  →  loader  →  pipeline
                                              ├─ Sources (flatfox, homegate, immoscout24-sitemap,
                                              │          realadvisor, immobilier-ch, schemaorg ×N)
                                              ├─ Canonical-key dedup (cross-source)
                                              ├─ Enrichers (commute, …)
                                              ├─ Rental-term gate (long/short, expiry)
                                              ├─ Filter (hard, AND-combined)
                                              ├─ Scorer (rule DSL, 0..100)
                                              ├─ Quota gate (daily UTC)
                                              └─ Notifier (telegram)

SQLite (Drizzle, FTS5) ←──── persists listings + scores + sends + commute cache
Browser bridge (127.0.0.1 WS) ←── extension-wabe proxies DataDome-walled requests
ORS + Motis + Pelias (docker)  ←── @wabe/enricher-commute
```

- [ ] **Step 3: Commit.**

```bash
git add plugins/enricher-commute/README.md README.md
git commit -m "docs: enricher-commute + commute stack in README"
```

---

## Task 18: Full-workspace verification

- [ ] **Step 1: Run the workspace CI script end-to-end.**

Run: `pnpm ci`
Expected: lint + format:check + typecheck + test all green across the full workspace.

- [ ] **Step 2: Probe a real running stack (optional, manual).**

If a local docker stack is up:

```bash
cd docker/commute && make up && sleep 30 && make health
pnpm wabe doctor
pnpm wabe scan
```

Expected: `[OK]` lines for all three endpoints; one or more scanned listings carry `enriched.commute`. Inspect via `pnpm wabe list`.

- [ ] **Step 3: Final commit (if any drift from format / lint).**

```bash
git add -u
git commit -m "chore: post-implementation lint/format" || true
```

---

## Self-review — coverage check

| Spec section | Implemented in |
|--------------|----------------|
| Architecture: `@wabe/enricher-commute` package | T5, T6, T7, T8, T9, T10, T11 |
| Architecture: DSL extension | T2 (grammar), T3 (filter eval), T4 (scoring eval) |
| Architecture: server pipeline wiring | T12 |
| Architecture: db migration | T1 |
| Architecture: docker compose | T15 |
| Config shape (`commute.yaml`) | T5 (Zod), T16 (example) |
| Data flow per listing | T11 (enrich orchestration) |
| Cache (quantize + tables + TTL) | T1, T7 |
| Listing schema additions | (n/a — payload lives in plugin) T5 |
| DSL primitive `commute(target, mode)` | T2, T3, T4 |
| Pipeline wiring sequence | T12 |
| Self-hosted infra | T15 |
| `wabe doctor` probe | T14 |
| `wabe cache clear --commute` | T13 |
| Error handling: best-effort failure | T8, T9, T10, T11 |
| Testing matrix | T2–T12 + T18 |
| File map | Task file lists |

All spec sections have at least one task. No placeholders, no TBDs.
