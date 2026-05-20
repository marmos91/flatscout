# `source-immoscout24` search-based plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@wabe/source-immoscout24-sitemap` with `@wabe/source-immoscout24`: a paginated SRP scanner that fetches IS24's search-result page HTML through the Wabe browser bridge, parses `window.__INITIAL_STATE__` for full-detail listings, and optionally fetches PDP HTML for contact-channel enrichment.

**Architecture:** Mirror the `@wabe/source-homegate` package layout (`transport.ts`/`client.ts`/`search.ts`/`map.ts`/`index.ts`). SRP page is one bridge request per page; 20 listings per page carry rooms/price/area/photos/description/geo natively. Optional PDP enrichment under an `enrich.enrich_via_bridge` flag merges only contact-shaped fields. No per-source state — server's `dedupe.ts` already handles cross-scan dedup via `listings.canonical_key`.

**Tech Stack:** TypeScript, Zod, `@wabe/browser-bridge`, `@wabe/plugin-sdk`, `@wabe/core` (`RawListing`, `classifyRentalTerm`), pino, vitest.

**Reference spec:** `docs/superpowers/specs/2026-05-19-immoscout24-search-source-design.md`.

---

## File Structure

### New / renamed package layout

```
plugins/source-immoscout24/                     (renamed from source-immoscout24-sitemap/)
├── package.json                                # name → @wabe/source-immoscout24, drop fast-xml-parser
├── README.md                                   # rewritten
├── src/
│   ├── index.ts                                # plugin factory: select transport, page loop, yield mapped listings
│   ├── search.ts                               # SearchConfig schema + buildSrpUrl(cfg, page)
│   ├── client.ts                               # fetchSrp(url, ctx) — bridge dispatch + retries + pacing
│   ├── parse.ts                                # extractInitialState(html) + IS24SrpListingSchema (Zod)
│   ├── map.ts                                  # mapSrpListing(card, lang) → RawListing
│   ├── enrich.ts                               # mergePdpIntoListing(listing, pdpPayload) — contact-only merge
│   ├── detail.ts                               # KEEP existing PDP extractor for opt-in enrichment
│   ├── transport.ts                            # selectTransport({dataDir, logger}) — clone of homegate's
│   └── errors.ts                               # IS24HttpError / IS24AntiBotError / IS24ParseError
└── test/
    ├── search.test.ts                          # SearchConfig → URL builder
    ├── parse.test.ts                           # captured SRP fixture → extractInitialState
    ├── map.test.ts                             # sample card → RawListing
    ├── enrich.test.ts                          # SRP listing + PDP merge rules
    ├── client.test.ts                          # stub-transport happy / retry / antibot / abort
    ├── transport.test.ts                       # selectTransport throws without bridge
    └── fixtures/
        ├── srp-zurich-page1.html               # live capture (~760 KB)
        └── pdp-sample.json                     # synthetic PDP payload for enrich.test
```

### Cross-cutting renames

| File                                                   | Change                                                          |
|--------------------------------------------------------|-----------------------------------------------------------------|
| `packages/server/package.json:24`                      | swap workspace dep                                              |
| `packages/core/src/canonical-key.ts:56`                | rename source key, keep weight 70                               |
| `packages/core/test/canonical-key.test.ts`             | rename literal                                                  |
| `packages/cli/src/commands/doctor.ts:11`               | rename in `DATADOME_SOURCES`                                    |
| `plugins/notifier-telegram/src/card.ts:19`             | rename source label                                             |
| `plugins/notifier-telegram/test/card.test.ts`          | rename in test                                                  |
| `examples/zurich-family/config/config.yaml:10,21`      | rename plugin entry + bridge comment                            |
| `examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml` | rename to `source-immoscout24.yaml`, rewrite content   |
| `README.md`                                            | rename source label, update description                         |
| `CLAUDE.md`                                            | rename in repository overview section                           |
| `pnpm-lock.yaml`                                       | regenerated automatically by `pnpm install` after package rename |
| `packages/db/migrations/0004_drop_is24_sitemap_state.sql` | new migration deleting orphan state row                      |

---

## Task 0: Bootstrap branch

**Files:** none (git only).

- [ ] **Step 1: Confirm clean working tree**

Run: `git status --porcelain`
Expected: empty (or only the already-committed spec files from the brainstorming step).

- [ ] **Step 2: Create branch**

Run: `git checkout -b source-immoscout24-search`

- [ ] **Step 3: Confirm bridge daemon running**

Run: `wabe bridge status` (or `cat ${XDG_DATA_HOME:-$HOME/.local/share}/wabe/bridge.status.json`)
Expected: `connected: true`. Required for the live capture in Task 1.

---

## Task 1: Capture SRP fixture via daemon bridge

**Files:**
- Create: `/tmp/is24-capture.mjs` (scratch — deleted at end of task)
- Create: `plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html` (will move to new package path in Task 3)

The plan-phase capture serves two purposes: locks in the SRP `__INITIAL_STATE__` shape against the live page, and produces a deterministic fixture for `parse.test.ts` / `map.test.ts` / `enrich.test.ts`.

- [ ] **Step 1: Write the capture script**

Create `/tmp/is24-capture.mjs`:

```js
import { DaemonBridgeTransport } from '/Users/marmos91/Projects/wabe/packages/browser-bridge/dist/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.WABE_DATA_DIR || `${process.env.HOME}/.local/share/wabe`;
const url = process.argv[2] || 'https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G';
const out = process.argv[3] || 'plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html';

const t = await DaemonBridgeTransport.tryConnect(dataDir);
if (!t) { console.error('no bridge daemon — start `wabe start` with paired extension'); process.exit(2); }

try {
  const r = await t.request({
    method: 'GET',
    url,
    headers: { accept: 'text/html,application/xhtml+xml' },
    timeout_ms: 30_000,
  });
  console.error('status', r.status, 'body len', r.body.length);
  if (r.status !== 200) { console.error('non-200 — abort'); process.exit(3); }
  mkdirSync(out.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(out, r.body);
  console.error('wrote', out);
} finally {
  await t.close();
}
```

- [ ] **Step 2: Build `@wabe/browser-bridge` so the dist import resolves**

Run: `pnpm --filter @wabe/browser-bridge build`
Expected: silent success.

- [ ] **Step 3: Run the capture**

Run: `node /tmp/is24-capture.mjs`
Expected output:
```
status 200 body len <number around 700000-800000>
wrote plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html
```

- [ ] **Step 4: Verify the fixture contains `__INITIAL_STATE__`**

Run: `grep -c "window.__INITIAL_STATE__" plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html`
Expected: `1`

- [ ] **Step 5: Inspect listing count to lock in expected pagination metadata**

Run:
```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html','utf8');
const m=html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
const j=JSON.parse(m[1]);
const r=j.resultList.search.fullSearch.result;
console.log({ listings: r.listings.length, page: r.page, pageCount: r.pageCount, hasNextPage: r.hasNextPage, itemsPerPage: r.itemsPerPage });
"
```
Expected: `listings: 20`, `page: 1`, `hasNextPage: true`, `itemsPerPage: 20`. Record `pageCount` and `resultCount` — used in Task 9 test assertions.

- [ ] **Step 6: Delete the scratch script**

Run: `rm /tmp/is24-capture.mjs`

- [ ] **Step 7: Commit the fixture**

```bash
git add plugins/source-immoscout24-sitemap/test/fixtures/srp-zurich-page1.html
git -c commit.gpgsign=true commit -S -m "test(is24): capture live SRP fixture (page 1, Zurich)"
```

---

## Task 2: Capture filter / sort / multi-zip URL probes

This locks in the exact IS24 query-param names that Section 6 of the spec flagged as "verified at plan capture". Performed manually in the paired browser; outputs are recorded in `parse.test.ts` and `search.test.ts` later.

- [ ] **Step 1: Open IS24 SRP in the paired browser**

URL: `https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G`

- [ ] **Step 2: Apply each filter individually and record the URL the browser navigates to**

Toggle one filter at a time (refresh the page between toggles). Record verbatim:

| Filter UI                            | URL fragment       | Param assignment                |
|--------------------------------------|--------------------|---------------------------------|
| Min price 1500                       | `&___________`     |                                 |
| Max price 3000                       | `&___________`     |                                 |
| Rooms min 2                          | `&___________`     |                                 |
| Rooms max 4                          | `&___________`     |                                 |
| Surface min 60                       | `&___________`     |                                 |
| Sort by price ascending              | `&___________`     |                                 |
| Sort by date descending              | `&___________`     |                                 |
| Page 2 navigation                    | `&___________`     |                                 |

- [ ] **Step 3: Test multi-zipcode behavior**

Pick zipcodes `8001` and `8002`. Try a URL that joins them and check whether IS24 returns the union or 404s:

- Variant A: `?wzip=8001,8002` — record HTTP status + listing count.
- Variant B: `?wzip=8001&wzip=8002` — record HTTP status + listing count.

Decide single-URL vs fan-out behavior for Task 6 (`buildSrpUrl`). Record decision inline in a temporary scratch note.

- [ ] **Step 4: Test single-zipcode behavior for an arbitrary Swiss zip**

Open `https://www.immoscout24.ch/en/real-estate/rent?wzip=3000&an=G` (or whatever param Step 2 revealed).
Expected: HTTP 200 with listings. If 404, fall back to `city-bern` slug — record which works.

- [ ] **Step 5: Capture one PDP for enrichment fixture**

Pick any listing ID from `srp-zurich-page1.html`. Open it in the paired browser. Save HTML via DevTools "Save as" or via the capture script reused with the PDP URL:

```bash
node /tmp/is24-capture.mjs https://www.immoscout24.ch/rent/<id> /tmp/pdp-sample.html
```

(The scratch script was deleted; recreate it inline for this one capture, then delete again.)

Confirm the PDP has either JSON-LD or `__NEXT_DATA__`:
```bash
grep -c 'application/ld+json\|__NEXT_DATA__' /tmp/pdp-sample.html
```
Expected: >= 1.

Run the existing extractor:
```bash
node -e "
const { extractDetail } = require('./plugins/source-immoscout24-sitemap/dist/detail.js');
const html=require('fs').readFileSync('/tmp/pdp-sample.html','utf8');
console.log(JSON.stringify(extractDetail(html), null, 2));
" | head -80
```
(May need `pnpm --filter @wabe/source-immoscout24-sitemap build` first.)

If the result has `listing.offers.price` and `listing.address` filled, the existing `detail.ts` is good. If not, record the gap — patched in Task 11.

- [ ] **Step 6: Record findings as scratch note**

Create `/tmp/is24-plan-findings.md` with the verified URL params and the multi-zip / PDP shape decisions. Used inline in the implementation tasks below; not committed.

---

## Task 3: Rename package on disk + update package.json

**Files:**
- Move: `plugins/source-immoscout24-sitemap/` → `plugins/source-immoscout24/`
- Modify: `plugins/source-immoscout24/package.json`

This task does the directory rename and the `package.json` rename. The source files inside (`map.ts`, `state.ts`, `index.ts`, etc.) are rewritten in later tasks; for now they continue to exist with the old shape and the build will be temporarily broken. **The next task (Task 4) updates the workspace dep + the lockfile + verifies the build re-resolves before further refactors.**

- [ ] **Step 1: Rename the directory**

Run: `git mv plugins/source-immoscout24-sitemap plugins/source-immoscout24`

- [ ] **Step 2: Replace `plugins/source-immoscout24/package.json`**

Drop `fast-xml-parser` (no longer needed — no sitemap parsing) and rename:

```json
{
  "name": "@wabe/source-immoscout24",
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
    "@wabe/browser-bridge": "workspace:*",
    "@wabe/core": "workspace:*",
    "@wabe/db": "workspace:*",
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

- [ ] **Step 3: Update tsbuildinfo path is invalidated; clean it**

Run: `rm -f plugins/source-immoscout24/tsconfig.tsbuildinfo plugins/source-immoscout24/dist -r`

- [ ] **Step 4: Update `packages/server/package.json` dep**

Find the line:
```json
    "@wabe/source-immoscout24-sitemap": "workspace:*",
```
Replace with:
```json
    "@wabe/source-immoscout24": "workspace:*",
```

- [ ] **Step 5: Run `pnpm install` to refresh the workspace + lockfile**

Run: `pnpm install`
Expected: `Done in <N>s` with no resolution errors. `pnpm-lock.yaml` updated.

- [ ] **Step 6: Confirm workspace knows the new package**

Run: `pnpm list --filter @wabe/source-immoscout24 --depth=-1`
Expected: shows `@wabe/source-immoscout24@0.0.0 plugins/source-immoscout24`.

- [ ] **Step 7: Commit the rename**

```bash
git add plugins/source-immoscout24 packages/server/package.json pnpm-lock.yaml
git -c commit.gpgsign=true commit -S -m "refactor(is24): rename source-immoscout24-sitemap → source-immoscout24"
```

Note: the build is still broken at this point — the source files reference `source-immoscout24-sitemap`. Fixed across Tasks 5–13.

---

## Task 4: Delete now-obsolete sitemap source files

**Files:**
- Delete: `plugins/source-immoscout24/src/sitemap.ts`
- Delete: `plugins/source-immoscout24/src/state.ts`
- Delete: `plugins/source-immoscout24/src/map.ts` (will be rewritten in Task 8)
- Delete: `plugins/source-immoscout24/src/index.ts` (will be rewritten in Task 12)
- Delete: `plugins/source-immoscout24/test/map.test.ts` (will be rewritten in Task 8)
- Delete: existing `plugins/source-immoscout24/test/sitemap.test.ts` if present

The sitemap code path is gone. `detail.ts` stays — it's reused by the opt-in PDP enricher.

- [ ] **Step 1: Delete obsolete source files**

```bash
git rm plugins/source-immoscout24/src/sitemap.ts \
       plugins/source-immoscout24/src/state.ts \
       plugins/source-immoscout24/src/map.ts \
       plugins/source-immoscout24/src/index.ts
```

- [ ] **Step 2: Delete obsolete tests**

```bash
git rm plugins/source-immoscout24/test/map.test.ts
test -f plugins/source-immoscout24/test/sitemap.test.ts && git rm plugins/source-immoscout24/test/sitemap.test.ts || true
test -f plugins/source-immoscout24/test/state.test.ts   && git rm plugins/source-immoscout24/test/state.test.ts   || true
```

- [ ] **Step 3: Commit**

```bash
git -c commit.gpgsign=true commit -S -m "refactor(is24): drop sitemap source + state files (replaced by SRP-based plugin)"
```

---

## Task 5: Implement `errors.ts`

**Files:**
- Create: `plugins/source-immoscout24/src/errors.ts`
- Create: `plugins/source-immoscout24/test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IS24HttpError, IS24AntiBotError, IS24ParseError } from '../src/errors.js';

describe('IS24HttpError', () => {
  it('serialises status + url in the message', () => {
    const err = new IS24HttpError(500, 'https://x', 'boom');
    expect(err.message).toContain('500');
    expect(err.message).toContain('https://x');
    expect(err.message).toContain('boom');
  });
});

describe('IS24AntiBotError', () => {
  it('hints at the bridge-refresh remedy', () => {
    const err = new IS24AntiBotError('https://x');
    expect(err.message).toMatch(/datadome/i);
    expect(err.message).toMatch(/paired browser/i);
  });
});

describe('IS24ParseError', () => {
  it('is an Error', () => {
    expect(new IS24ParseError('x')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `errors.ts`**

```ts
export class IS24HttpError extends Error {
  constructor(public status: number, public url: string, public body?: string) {
    super(`immoscout24 HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export class IS24AntiBotError extends IS24HttpError {
  constructor(url: string, body?: string) {
    super(403, url, body);
    this.message = `immoscout24 DataDome blocked ${url} — open https://www.immoscout24.ch/ in your paired browser once to refresh the session`;
  }
}

export class IS24ParseError extends Error {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/errors.ts plugins/source-immoscout24/test/errors.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): add typed error classes (Http/AntiBot/Parse)"
```

---

## Task 6: Implement `search.ts` (SearchConfig + buildSrpUrl)

**Files:**
- Create: `plugins/source-immoscout24/src/search.ts`
- Create: `plugins/source-immoscout24/test/search.test.ts`

**Plan-capture inputs** — substitute the IS24 query-param names verified in Task 2. Placeholder names below assume the most common IS24 conventions; if Task 2 revealed different names, swap them verbatim.

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SearchConfig, buildSrpUrl } from '../src/search.js';

describe('SearchConfig', () => {
  it('applies sensible defaults', () => {
    const cfg = SearchConfig.parse({});
    expect(cfg.language).toBe('en');
    expect(cfg.property_type).toBe('APARTMENT_OR_HOUSE');
    expect(cfg.offer_type).toBe('RENT');
    expect(cfg.sort_by).toBe('dateCreated');
    expect(cfg.sort_direction).toBe('desc');
  });
});

describe('buildSrpUrl', () => {
  it('emits the root URL with no location and an=G when zipcodes is empty', () => {
    const url = buildSrpUrl(SearchConfig.parse({}), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1');
  });

  it('uses the city-<slug> path when a single known zipcode resolves', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [8001] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G&pn=1');
  });

  it('falls back to wzip param for unknown zipcodes', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [3000] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1&wzip=3000');
  });

  it('emits multi-zip via comma-joined wzip when more than one is configured', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [8001, 8002] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1&wzip=8001%2C8002');
  });

  it('translates filter fields into query params', () => {
    const cfg = SearchConfig.parse({
      zipcodes: [8001],
      price_min: 1500,
      price_max: 3000,
      rooms_min: 2,
      rooms_max: 4,
      surface_min: 60,
      sort_by: 'price',
      sort_direction: 'asc',
    });
    const url = buildSrpUrl(cfg, 3);
    expect(url).toContain('/en/real-estate/rent/city-zurich');
    expect(url).toContain('&pn=3');
    expect(url).toContain('&ps=1500');
    expect(url).toContain('&pe=3000');
    expect(url).toContain('&nrf=2');
    expect(url).toContain('&nrt=4');
    expect(url).toContain('&slf=60');
    expect(url).toContain('&srt=price');
    expect(url).toContain('&sdt=asc');
  });

  it('honors language', () => {
    const url = buildSrpUrl(SearchConfig.parse({ language: 'de' }), 1);
    expect(url).toContain('/de/immobilien/mieten');
  });

  it('encodes property_type as category param when not the default', () => {
    const url = buildSrpUrl(SearchConfig.parse({ property_type: 'HOUSE' }), 1);
    expect(url).toContain('&cat=house');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `search.ts`**

```ts
import { z } from 'zod';

export const SearchConfig = z.object({
  zipcodes: z.array(z.number().int().min(1000).max(9999)).default([]),
  price_max: z.number().int().positive().optional(),
  price_min: z.number().int().positive().optional(),
  rooms_min: z.number().positive().optional(),
  rooms_max: z.number().positive().optional(),
  surface_min: z.number().int().positive().optional(),
  property_type: z.enum(['APARTMENT_OR_HOUSE', 'APARTMENT', 'HOUSE']).default('APARTMENT_OR_HOUSE'),
  offer_type: z.literal('RENT').default('RENT'),
  has_balcony: z.boolean().optional(),
  has_elevator: z.boolean().optional(),
  sort_by: z.enum(['dateCreated', 'price', 'roomCount', 'livingSpace']).default('dateCreated'),
  sort_direction: z.enum(['asc', 'desc']).default('desc'),
  language: z.enum(['de', 'fr', 'it', 'en']).default('en'),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

const BASE = 'https://www.immoscout24.ch';

const PATH_PER_LANG: Record<SearchConfig['language'], string> = {
  en: '/en/real-estate/rent',
  de: '/de/immobilien/mieten',
  fr: '/fr/immobilier/louer',
  it: '/it/immobili/affittare',
};

/**
 * Minimal known-zipcode → city-slug table. IS24 supports slug-style URLs for
 * popular cities; unknown zipcodes fall through to the `wzip` query param.
 * Extend as needed — the wzip fallback always works.
 */
const KNOWN_CITY_SLUGS: Record<number, string> = {
  8001: 'city-zurich', 8002: 'city-zurich', 8003: 'city-zurich', 8004: 'city-zurich',
  8005: 'city-zurich', 8006: 'city-zurich', 8008: 'city-zurich', 8032: 'city-zurich',
  1201: 'city-geneva', 1202: 'city-geneva', 1203: 'city-geneva', 1204: 'city-geneva',
  4001: 'city-basel', 4051: 'city-basel', 4052: 'city-basel', 4053: 'city-basel', 4054: 'city-basel',
  3000: 'city-bern', 3011: 'city-bern', 3012: 'city-bern', 3013: 'city-bern', 3014: 'city-bern',
  6000: 'city-lucerne', 6003: 'city-lucerne', 6004: 'city-lucerne', 6005: 'city-lucerne',
  9000: 'city-stgallen', 9001: 'city-stgallen', 9008: 'city-stgallen',
};

function resolveLocationSegment(zipcodes: readonly number[]): { pathSegment: string; wzip: string | null } {
  if (zipcodes.length === 0) return { pathSegment: '', wzip: null };
  if (zipcodes.length === 1) {
    const slug = KNOWN_CITY_SLUGS[zipcodes[0]!];
    if (slug) return { pathSegment: `/${slug}`, wzip: null };
    return { pathSegment: '', wzip: String(zipcodes[0]) };
  }
  // Multi-zip: single URL with comma-joined wzip (validated working at Task 2).
  return { pathSegment: '', wzip: zipcodes.join(',') };
}

export function buildSrpUrl(cfg: SearchConfig, page: number): string {
  const { pathSegment, wzip } = resolveLocationSegment(cfg.zipcodes);
  const url = new URL(`${BASE}${PATH_PER_LANG[cfg.language]}${pathSegment}`);

  // Order: an=G first, pn second, then filters, then sort. URLSearchParams
  // preserves insertion order on stringify, which keeps the test assertions
  // (and human-readable URLs) stable.
  url.searchParams.set('an', 'G');
  url.searchParams.set('pn', String(page));

  if (wzip !== null) url.searchParams.set('wzip', wzip);
  if (cfg.price_min != null) url.searchParams.set('ps', String(cfg.price_min));
  if (cfg.price_max != null) url.searchParams.set('pe', String(cfg.price_max));
  if (cfg.rooms_min != null) url.searchParams.set('nrf', String(cfg.rooms_min));
  if (cfg.rooms_max != null) url.searchParams.set('nrt', String(cfg.rooms_max));
  if (cfg.surface_min != null) url.searchParams.set('slf', String(cfg.surface_min));
  if (cfg.has_balcony === true) url.searchParams.set('bal', '1');
  if (cfg.has_elevator === true) url.searchParams.set('lif', '1');
  if (cfg.property_type !== 'APARTMENT_OR_HOUSE') {
    url.searchParams.set('cat', cfg.property_type === 'HOUSE' ? 'house' : 'apartment');
  }
  if (cfg.sort_by !== 'dateCreated' || cfg.sort_direction !== 'desc') {
    url.searchParams.set('srt', cfg.sort_by);
    url.searchParams.set('sdt', cfg.sort_direction);
  }
  return url.toString();
}
```

If Task 2 revealed different IS24 query-param names (`ps`/`pe`/`nrf`/`nrt`/`slf`/`bal`/`lif`/`cat`/`srt`/`sdt`/`wzip`), swap them in both the test and the implementation. The structure stays.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/search.ts plugins/source-immoscout24/test/search.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): SearchConfig + buildSrpUrl"
```

---

## Task 7: Implement `parse.ts` (extractInitialState + Zod schemas)

**Files:**
- Move: `plugins/source-immoscout24/test/fixtures/srp-zurich-page1.html` is already in place (Task 1).
- Create: `plugins/source-immoscout24/src/parse.ts`
- Create: `plugins/source-immoscout24/test/parse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInitialState, IS24SrpListingSchema } from '../src/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures', 'srp-zurich-page1.html'), 'utf8');

describe('extractInitialState', () => {
  it('returns null when the marker is missing', () => {
    expect(extractInitialState('<html><body>no state here</body></html>')).toBeNull();
  });

  it('returns null when the embedded JSON is malformed', () => {
    expect(extractInitialState('<script>window.__INITIAL_STATE__ = {not json};</script>')).toBeNull();
  });

  it('extracts pagination metadata + a typed listings array from a real SRP page', () => {
    const state = extractInitialState(html);
    expect(state).not.toBeNull();
    const result = state!.resultList.search.fullSearch.result;
    expect(result.listings).toHaveLength(20);
    expect(result.page).toBe(1);
    expect(result.itemsPerPage).toBe(20);
    expect(typeof result.hasNextPage).toBe('boolean');
    expect(typeof result.resultCount).toBe('number');
  });

  it('each listing matches IS24SrpListingSchema', () => {
    const state = extractInitialState(html)!;
    for (const card of state.resultList.search.fullSearch.result.listings) {
      const parsed = IS24SrpListingSchema.safeParse(card);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parse.ts`**

```ts
import { z } from 'zod';

const Attachment = z
  .object({
    alt: z.string().nullable().optional(),
    file: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const Localization = z
  .object({
    text: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    attachments: z.array(Attachment).optional(),
  })
  .partial()
  .passthrough();

const Address = z
  .object({
    geoCoordinates: z
      .object({
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        accuracy: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    locality: z.string().optional(),
    postalCode: z.string().optional(),
    street: z.string().optional(),
  })
  .partial()
  .passthrough();

const Characteristics = z
  .object({
    numberOfRooms: z.number().optional(),
    livingSpace: z.number().optional(),
    hasBalcony: z.boolean().optional(),
    hasElevator: z.boolean().optional(),
    hasParking: z.boolean().optional(),
    hasGarage: z.boolean().optional(),
    hasDishwasher: z.boolean().optional(),
    yearBuilt: z.number().optional(),
    yearLastRenovated: z.number().optional(),
    numberOfBathrooms: z.number().optional(),
  })
  .partial()
  .passthrough();

const Prices = z
  .object({
    rent: z
      .object({
        gross: z.number().optional(),
        net: z.number().optional(),
        interval: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    currency: z.string().optional(),
  })
  .partial()
  .passthrough();

export const IS24SrpListingSchema = z
  .object({
    id: z.string(),
    listingType: z.object({ type: z.string().optional() }).partial().passthrough().optional(),
    listing: z
      .object({
        id: z.string().optional(),
        address: Address.optional(),
        categories: z.array(z.string()).optional(),
        characteristics: Characteristics.optional(),
        localization: z
          .object({
            de: Localization.optional(),
            en: Localization.optional(),
            fr: Localization.optional(),
            it: Localization.optional(),
          })
          .partial()
          .passthrough()
          .optional(),
        meta: z.object({ createdAt: z.string().optional() }).partial().passthrough().optional(),
        offerType: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        prices: Prices.optional(),
      })
      .passthrough(),
    listerBranding: z
      .object({
        logoUrl: z.string().optional(),
        subscriptionType: z.string().optional(),
        basePackage: z.string().optional(),
        isQualityPartner: z.boolean().optional(),
        isPremiumBranding: z.boolean().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();
export type IS24SrpListing = z.infer<typeof IS24SrpListingSchema>;

export const IS24SearchResultSchema = z.object({
  resultList: z.object({
    search: z.object({
      fullSearch: z.object({
        result: z.object({
          listings: z.array(IS24SrpListingSchema),
          page: z.number(),
          pageCount: z.number(),
          resultCount: z.number(),
          itemsPerPage: z.number(),
          hasNextPage: z.boolean(),
          hasPreviousPage: z.boolean(),
          start: z.number(),
        }).passthrough(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();
export type IS24SearchResult = z.infer<typeof IS24SearchResultSchema>;

const INITIAL_STATE_RE = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;

/**
 * Extracts the inline `window.__INITIAL_STATE__` object from an IS24 SRP page
 * and validates the listings-shaped subtree. Returns null on any structural
 * mismatch (missing script tag, malformed JSON, schema fail) so callers can
 * skip the page and continue.
 */
export function extractInitialState(html: string): IS24SearchResult | null {
  const m = html.match(INITIAL_STATE_RE);
  if (!m?.[1]) return null;
  let blob: unknown;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const parsed = IS24SearchResultSchema.safeParse(blob);
  if (!parsed.success) return null;
  return parsed.data;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/parse.ts plugins/source-immoscout24/test/parse.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): extractInitialState + Zod schemas for SRP shape"
```

---

## Task 8: Implement `map.ts` (SRP listing → RawListing)

**Files:**
- Create: `plugins/source-immoscout24/src/map.ts`
- Create: `plugins/source-immoscout24/test/map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/map.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInitialState } from '../src/parse.js';
import { mapSrpListing } from '../src/map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures', 'srp-zurich-page1.html'), 'utf8');
const state = extractInitialState(html)!;
const cards = state.resultList.search.fullSearch.result.listings;

describe('mapSrpListing', () => {
  it('returns null when listing.id is missing', () => {
    expect(mapSrpListing({ ...cards[0]!, id: '' as unknown as string }, 'en')).toBeNull();
  });

  it('produces a RawListing with canonical fields populated from the SRP card', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(r.source).toBe('source-immoscout24');
    expect(r.id).toMatch(/^immoscout24:\d+$/);
    expect(r.url).toMatch(/^https:\/\/www\.immoscout24\.ch\/rent\/\d+$/);
    expect(typeof r.price.total === 'number' || r.price.total === null).toBe(true);
    expect(typeof r.rooms === 'number' || r.rooms === null).toBe(true);
    expect(typeof r.area_m2 === 'number' || r.area_m2 === null).toBe(true);
    expect(r.location.country).toBe('CH');
  });

  it('reads localization in the configured language with fallback', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(typeof r.description === 'string' || r.description === null).toBe(true);
    if (r.description) expect(r.description.length).toBeGreaterThan(0);
  });

  it('extracts photo URLs from localization.<lang>.attachments where type=IMAGE', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(Array.isArray(r.photos)).toBe(true);
    for (const u of r.photos) expect(u).toMatch(/^https:\/\/cdn\.immoscout24\.ch\//);
  });

  it('records cross-platform flags under enriched.cross_listed_on', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(Array.isArray((r.enriched as Record<string, unknown>).cross_listed_on)).toBe(true);
  });

  it('leaves agency=null and contact={} when SRP carries no contact info', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(r.agency).toBeNull();
    expect(r.contact).toEqual({});
  });

  it('reads geo coordinates in GeoJSON [lng, lat] order', () => {
    const card = cards.find((c) => c.listing.address?.geoCoordinates?.latitude != null)!;
    const r = mapSrpListing(card, 'de')!;
    expect(Array.isArray(r.location.coords)).toBe(true);
    expect(r.location.coords).toHaveLength(2);
    const [lng, lat] = r.location.coords!;
    expect(lat).toBeGreaterThan(45);
    expect(lat).toBeLessThan(48);
    expect(lng).toBeGreaterThan(5);
    expect(lng).toBeLessThan(11);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `map.ts`**

```ts
import { classifyRentalTerm, type RawListing } from '@wabe/core';
import type { IS24SrpListing } from './parse.js';

type Lang = 'de' | 'en' | 'fr' | 'it';

const LANG_FALLBACK: Lang[] = ['de', 'en', 'fr', 'it'];

function pickLocalization(card: IS24SrpListing, primary: Lang) {
  const loc = card.listing.localization;
  if (!loc) return undefined;
  const order: Lang[] = [primary, ...LANG_FALLBACK.filter((l) => l !== primary)];
  for (const lang of order) {
    const entry = loc[lang];
    if (entry?.text || entry?.attachments?.length) return entry;
  }
  return undefined;
}

/**
 * Maps one IS24 SRP card to the canonical RawListing shape. Returns null when
 * the card lacks a usable id — the caller logs and skips. SRP cards never
 * carry contact channels (phone/email/form_url); those are filled later by
 * `enrich.ts` if PDP enrichment is enabled.
 */
export function mapSrpListing(card: IS24SrpListing, primaryLang: Lang): RawListing | null {
  const id = card.id || card.listing.id;
  if (!id) return null;
  const url = `https://www.immoscout24.ch/rent/${id}`;

  const chars = card.listing.characteristics ?? {};
  const prices = card.listing.prices ?? {};
  const rent = prices.rent ?? {};
  const address = card.listing.address ?? {};
  const geo = address.geoCoordinates;
  const coords: [number, number] | null =
    geo?.latitude != null && geo.longitude != null ? [geo.longitude, geo.latitude] : null;

  const entry = pickLocalization(card, primaryLang);
  const description = entry?.text?.description ?? null;
  const title = entry?.text?.title ?? null;
  const photos = (entry?.attachments ?? [])
    .filter((a) => a.type === 'IMAGE' && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => a.url as string);

  const classified = classifyRentalTerm({
    description,
    is_furnished: null,
    lease_until: null,
    min_stay_days: null,
  });

  const features: Record<string, unknown> = {};
  if (chars.hasBalcony != null) features.has_balcony = chars.hasBalcony;
  if (chars.hasElevator != null) features.has_elevator = chars.hasElevator;
  if (chars.hasParking != null) features.has_parking = chars.hasParking;
  if (chars.hasGarage != null) features.has_garage = chars.hasGarage;
  if (chars.hasDishwasher != null) features.has_dishwasher = chars.hasDishwasher;
  if (chars.numberOfBathrooms != null) features.bathrooms = chars.numberOfBathrooms;

  const enriched: Record<string, unknown> = {};
  const lister: Record<string, unknown> = {};
  if (card.listerBranding?.logoUrl) lister.logo_url = card.listerBranding.logoUrl;
  if (Object.keys(lister).length > 0) enriched.lister = lister;
  if (Array.isArray(card.listing.platforms)) {
    enriched.cross_listed_on = Array.from(
      new Set(card.listing.platforms.map((p) => p.toLowerCase())),
    ).sort();
  }
  if (card.listingType?.type) {
    enriched.is24 = { listing_type: card.listingType.type, subscription_type: card.listerBranding?.subscriptionType ?? null };
  }

  const postedAt = (() => {
    const raw = card.listing.meta?.createdAt;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  })();

  return {
    id: `immoscout24:${id}`,
    source: 'source-immoscout24',
    url,
    price: {
      rent_net: rent.net ?? null,
      extras: null,
      total: rent.gross ?? null,
      currency: prices.currency ?? 'CHF',
      deposit_months: null,
    },
    rooms: chars.numberOfRooms ?? null,
    area_m2: chars.livingSpace ?? null,
    floor: null,
    total_floors: null,
    built_year: chars.yearBuilt ?? null,
    renovated_year: chars.yearLastRenovated ?? null,
    location: {
      coords,
      address: address.street ?? null,
      postal_code: address.postalCode ?? null,
      city: address.locality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description,
    photos,
    available_from: postedAt,
    lease_until: classified.lease_until,
    rental_term: classified.rental_term,
    agency: null,
    features,
    contact: {},
    enriched,
    extra: { title },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test map.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/map.ts plugins/source-immoscout24/test/map.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): mapSrpListing — IS24 card → RawListing"
```

---

## Task 9: Implement `transport.ts` (selectTransport)

**Files:**
- Create: `plugins/source-immoscout24/src/transport.ts`
- Create: `plugins/source-immoscout24/test/transport.test.ts`

Identical contract to homegate's; the only differences are the kind tag label and the error message.

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTransport } from '../src/transport.js';

const logger = pino({ level: 'silent' });

describe('selectTransport (is24)', () => {
  it('throws when no in-process bridge and no daemon heartbeat', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wabe-is24-sel-'));
    await expect(selectTransport({ dataDir: tmp, logger })).rejects.toThrow(/browser bridge/i);
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `transport.ts`**

```ts
import type { Logger } from 'pino';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type Transport as BridgeTransport,
} from '@wabe/browser-bridge';

export type TransportKind = 'bridge-inproc' | 'bridge-daemon';

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD';
  url: string;
  signal: AbortSignal;
  logger: Logger;
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

export interface Transport {
  readonly kind: TransportKind;
  request(opts: TransportRequestOpts): Promise<TransportResponse>;
  close?(): Promise<void>;
}

export class IS24BridgeTransport implements Transport {
  constructor(
    readonly kind: TransportKind,
    private readonly inner: BridgeTransport,
    private readonly onClose?: () => Promise<void>,
  ) {}

  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: { accept: 'text/html,application/xhtml+xml' },
      timeout_ms: opts.timeoutMs,
      signal: opts.signal,
    });
    return { status: resp.status, body: resp.body };
  }

  async close(): Promise<void> {
    if (this.onClose) await this.onClose();
  }
}

export interface SelectTransportOpts {
  dataDir: string;
  logger: Logger;
}

export async function selectTransport(opts: SelectTransportOpts): Promise<Transport> {
  const local = getCurrentBridge();
  if (local) {
    opts.logger.info('immoscout24: using in-process bridge transport');
    return new IS24BridgeTransport('bridge-inproc', new BrowserBridgeTransport(local));
  }
  const daemon = await DaemonBridgeTransport.tryConnect(opts.dataDir);
  if (daemon) {
    opts.logger.info('immoscout24: using daemon bridge transport (cross-process)');
    return new IS24BridgeTransport('bridge-daemon', daemon, async () => {
      await daemon.close();
    });
  }
  throw new Error(
    'source-immoscout24 requires the Wabe browser bridge. ' +
      'Start `wabe start` with the extension paired, or run `wabe bridge pair` to set it up.',
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/transport.ts plugins/source-immoscout24/test/transport.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): selectTransport — bridge in-proc / daemon / hard-fail"
```

---

## Task 10: Implement `client.ts` (fetchSrp + retries)

**Files:**
- Create: `plugins/source-immoscout24/src/client.ts`
- Create: `plugins/source-immoscout24/test/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { fetchSrp, sleep } from '../src/client.js';
import { IS24AntiBotError, IS24HttpError } from '../src/errors.js';
import type { Transport, TransportRequestOpts, TransportResponse } from '../src/transport.js';

const logger = pino({ level: 'silent' });

function makeTransport(opts: {
  responses: Array<TransportResponse | (() => TransportResponse)>;
}): Transport & { calls: TransportRequestOpts[] } {
  let i = 0;
  const calls: TransportRequestOpts[] = [];
  const t: Transport & { calls: TransportRequestOpts[] } = {
    kind: 'bridge-inproc',
    calls,
    async request(o) {
      calls.push(o);
      const item = opts.responses[i++];
      if (item === undefined) throw new Error(`no more stub responses (call #${i})`);
      return typeof item === 'function' ? item() : item;
    },
  };
  return t;
}

const ctxBase = {
  paceMs: 0,
  backoff: { on: [429, 500, 502, 503, 504], retries: 2, base_ms: 1 },
  signal: new AbortController().signal,
  logger,
};

const okBody = '<html><body>ok</body></html>';

describe('fetchSrp', () => {
  it('returns the happy-path response body + status', async () => {
    const t = makeTransport({ responses: [{ status: 200, body: okBody }] });
    const res = await fetchSrp('https://x', { ...ctxBase, transport: t });
    expect(res.body).toBe(okBody);
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.method).toBe('GET');
  });

  it('throws IS24AntiBotError on 403', async () => {
    const t = makeTransport({ responses: [{ status: 403, body: 'blocked' }] });
    await expect(fetchSrp('https://x', { ...ctxBase, transport: t })).rejects.toBeInstanceOf(IS24AntiBotError);
  });

  it('retries on 429 then succeeds', async () => {
    const t = makeTransport({
      responses: [
        { status: 429, body: 'slow down' },
        { status: 200, body: okBody },
      ],
    });
    const res = await fetchSrp('https://x', {
      ...ctxBase,
      transport: t,
      backoff: { on: [429], retries: 2, base_ms: 1 },
    });
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });

  it('throws IS24HttpError when 500 budget is exhausted', async () => {
    const t = makeTransport({
      responses: [
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
      ],
    });
    await expect(
      fetchSrp('https://x', {
        ...ctxBase,
        transport: t,
        backoff: { on: [500], retries: 2, base_ms: 1 },
      }),
    ).rejects.toBeInstanceOf(IS24HttpError);
  });

  it('aborts before the next attempt when the signal fires', async () => {
    const ac = new AbortController();
    const t = makeTransport({
      responses: [
        () => {
          ac.abort();
          return { status: 500, body: 'x' };
        },
      ],
    });
    await expect(
      fetchSrp('https://x', {
        ...ctxBase,
        transport: t,
        signal: ac.signal,
        backoff: { on: [500], retries: 2, base_ms: 1000 },
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('sleep', () => {
  it('resolves after the configured delay', async () => {
    const start = Date.now();
    await sleep(5, new AbortController().signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  it('rejects with "aborted" when the signal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1);
    await expect(sleep(1000, ac.signal)).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client.ts`**

```ts
import type { Logger } from 'pino';
import { IS24AntiBotError, IS24HttpError } from './errors.js';
import type { Transport } from './transport.js';

export interface FetchContext {
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
  logger: Logger;
  transport: Transport;
}

export interface FetchSrpResponse {
  status: number;
  body: string;
}

/**
 * GETs an IS24 SRP URL through the bridge transport. Retries the configured
 * status codes with exponential backoff. A 403 always surfaces as
 * `IS24AntiBotError` — DataDome binds its cookie to the user's real browser
 * session and there is no Node-side recovery; the operator must reload an
 * IS24 page in the paired browser to refresh the session.
 */
export async function fetchSrp(url: string, ctx: FetchContext): Promise<FetchSrpResponse> {
  for (let attempt = 0; attempt <= ctx.backoff.retries; ) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const res = await ctx.transport.request({
      method: 'GET',
      url,
      signal: ctx.signal,
      logger: ctx.logger,
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, body: res.body };
    }
    if (res.status === 403) {
      throw new IS24AntiBotError(url, res.body);
    }
    if (!ctx.backoff.on.includes(res.status) || attempt === ctx.backoff.retries) {
      throw new IS24HttpError(res.status, url, res.body);
    }
    await sleep(ctx.backoff.base_ms * 2 ** attempt, ctx.signal);
    attempt += 1;
  }
  throw new IS24HttpError(0, url, 'unreachable');
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/client.ts plugins/source-immoscout24/test/client.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): fetchSrp client with retry/backoff"
```

---

## Task 11: Implement `enrich.ts` (opt-in PDP merge)

**Files:**
- Create: `plugins/source-immoscout24/src/enrich.ts`
- Create: `plugins/source-immoscout24/test/enrich.test.ts`
- Touch: `plugins/source-immoscout24/src/detail.ts` (already exists; verify it still compiles)

The merge rule: PDP fills **only** contact-shaped gaps. Never overwrite SRP fields. SRP is authoritative for rooms / price / area / description / photos / geo.

- [ ] **Step 1: Write the failing test**

Create `plugins/source-immoscout24/test/enrich.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RawListing } from '@wabe/core';
import type { DetailPayload } from '../src/detail.js';
import { mergePdpIntoListing } from '../src/enrich.js';

function baseListing(): RawListing {
  return {
    id: 'immoscout24:1',
    source: 'source-immoscout24',
    url: 'https://www.immoscout24.ch/rent/1',
    price: { rent_net: null, extras: null, total: 2400, currency: 'CHF', deposit_months: null },
    rooms: 3.5,
    area_m2: 78,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: 'Seestrasse 12',
      postal_code: '8002',
      city: 'Zürich',
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description: 'SRP description',
    photos: ['https://cdn/srp.jpg'],
    available_from: null,
    lease_until: null,
    rental_term: 'PERMANENT',
    agency: null,
    features: {},
    contact: {},
    enriched: {},
    extra: {},
  };
}

describe('mergePdpIntoListing', () => {
  it('returns the listing unchanged when PDP payload is empty', () => {
    const before = baseListing();
    const after = mergePdpIntoListing(before, { listing: null });
    expect(after).toEqual(before);
  });

  it('fills contact.phone/email/form_url and agency from PDP when SRP left them empty', () => {
    const listing = baseListing();
    const pdp: DetailPayload = {
      listing: {
        '@type': 'RealEstateListing',
        offers: { price: 9999, priceCurrency: 'CHF' },
        address: { streetAddress: 'IGNORED', postalCode: '0000' },
        description: 'PDP description override (should NOT win)',
      } as DetailPayload['listing'],
    };
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.description).toBe('SRP description');
    expect(merged.price.total).toBe(2400);
    expect(merged.location.postal_code).toBe('8002');
  });

  it('does not overwrite SRP-authoritative fields (rooms/price/area/description/photos/geo)', () => {
    const listing = baseListing();
    const pdp: DetailPayload = {
      listing: {
        '@type': 'RealEstateListing',
        numberOfRooms: 99,
        floorSize: { value: 999 },
        offers: { price: 99999, priceCurrency: 'CHF' },
        description: 'override',
        image: ['https://cdn/pdp1.jpg'],
        address: { streetAddress: 'override', postalCode: '0000', addressLocality: 'override' },
      } as DetailPayload['listing'],
    };
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.rooms).toBe(3.5);
    expect(merged.area_m2).toBe(78);
    expect(merged.price.total).toBe(2400);
    expect(merged.description).toBe('SRP description');
    expect(merged.photos).toEqual(['https://cdn/srp.jpg']);
    expect(merged.location.address).toBe('Seestrasse 12');
  });

  it('fills enriched.lister fields when PDP carries them', () => {
    const listing = baseListing();
    // detail.ts current shape does not surface phone/email/legalName — when the
    // PDP capture in Task 2 shows IS24 PDPs include these, extend detail.ts +
    // this assertion together. For now, the merge function tolerates extra
    // keys under `pdp.listing` and pulls them through if present.
    const pdp = {
      listing: {
        '@type': 'RealEstateListing',
        name: 'Lovely Flat',
        contact: { phone: '+41 44 555 11 22', email: 'agent@example.ch' },
        provider: { name: 'ACME Immobilien AG', url: 'https://acme.ch' },
      } as DetailPayload['listing'] & Record<string, unknown>,
    };
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.contact).toEqual({ phone: '+41 44 555 11 22', email: 'agent@example.ch' });
    expect(merged.agency).toBe('ACME Immobilien AG');
    expect((merged.enriched as Record<string, unknown>).lister).toMatchObject({
      legal_name: 'ACME Immobilien AG',
      website: 'https://acme.ch',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wabe/source-immoscout24 test enrich.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `enrich.ts`**

```ts
import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

interface PdpListingExtra {
  contact?: { phone?: string; email?: string; form_url?: string };
  provider?: { name?: string; url?: string };
  telephone?: string;
  email?: string;
}

/**
 * Merges a PDP payload into a SRP-derived RawListing, filling contact-shaped
 * gaps without ever overwriting SRP-authoritative fields. SRP is the source of
 * truth for rooms / price / area / description / photos / geo — PDP carries
 * the contact channels (phone / email / form_url / agency name) that SRP
 * cards omit.
 */
export function mergePdpIntoListing(listing: RawListing, pdp: DetailPayload): RawListing {
  if (!pdp.listing) return listing;
  const pl = pdp.listing as DetailPayload['listing'] & PdpListingExtra;

  const next: RawListing = {
    ...listing,
    contact: { ...listing.contact },
    enriched: { ...listing.enriched },
  };
  const listerExtra: Record<string, unknown> = {
    ...(next.enriched.lister as Record<string, unknown> | undefined),
  };

  const phone = pl.contact?.phone ?? pl.telephone;
  if (phone && !next.contact.phone) next.contact.phone = phone;
  const email = pl.contact?.email ?? pl.email;
  if (email && !next.contact.email) next.contact.email = email;
  if (pl.contact?.form_url && !next.contact.form_url) next.contact.form_url = pl.contact.form_url;

  const providerName = pl.provider?.name;
  if (providerName) {
    if (!next.agency) next.agency = providerName;
    if (!listerExtra.legal_name) listerExtra.legal_name = providerName;
  }
  if (pl.provider?.url && !listerExtra.website) listerExtra.website = pl.provider.url;

  if (Object.keys(listerExtra).length > 0) next.enriched.lister = listerExtra;

  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wabe/source-immoscout24 test enrich.test.ts`
Expected: PASS (4 tests).

If the Task 2 PDP capture shows IS24's PDP carries contact under different keys (e.g. `__NEXT_DATA__` props), update `detail.ts` to surface them on `DetailPayload.listing` under the same field names the merger expects (`contact.phone`, `contact.email`, `provider.name`, `provider.url`), and re-run.

- [ ] **Step 5: Commit**

```bash
git add plugins/source-immoscout24/src/enrich.ts plugins/source-immoscout24/test/enrich.test.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): mergePdpIntoListing — contact-only PDP merge"
```

---

## Task 12: Implement `index.ts` (orchestrator)

**Files:**
- Create: `plugins/source-immoscout24/src/index.ts`

- [ ] **Step 1: Write `index.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, PluginExport, Source } from '@wabe/plugin-sdk';
import { fetchSrp, sleep } from './client.js';
import { extractInitialState } from './parse.js';
import { mapSrpListing } from './map.js';
import { mergePdpIntoListing } from './enrich.js';
import { extractDetail } from './detail.js';
import { SearchConfig, buildSrpUrl } from './search.js';
import { selectTransport, type Transport } from './transport.js';

const FetchConfig = z.object({
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2500),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const EnrichConfig = z.object({
  enrich_via_bridge: z.boolean().default(false),
  max_detail_per_scan: z.number().int().positive().default(40),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
  enrich: EnrichConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

function resolveDataDir(): string {
  if (process.env.WABE_DATA_DIR) return process.env.WABE_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'wabe');
}

let activeTransport: Transport | undefined;

const plugin: Source = {
  name: 'source-immoscout24',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const dataDir = resolveDataDir();
    const transport = await selectTransport({ dataDir, logger: ctx.logger });
    activeTransport = transport;
    let pdpFetched = 0;

    try {
      for (let page = 1; page <= cfg.fetch.max_pages; page += 1) {
        if (ctx.signal.aborted) return;
        const url = buildSrpUrl(cfg.search, page);
        const res = await fetchSrp(url, {
          paceMs: cfg.fetch.pace_ms,
          backoff: cfg.fetch.backoff,
          signal: ctx.signal,
          logger: ctx.logger,
          transport,
        });
        const state = extractInitialState(res.body);
        if (!state) {
          ctx.logger.warn({ url }, 'immoscout24: SRP missing __INITIAL_STATE__ — skipping page');
          break;
        }
        const result = state.resultList.search.fullSearch.result;

        for (const card of result.listings) {
          if (ctx.signal.aborted) return;
          let listing = mapSrpListing(card, cfg.search.language);
          if (!listing) {
            ctx.logger.warn({ id: card.id }, 'immoscout24: card missing id — skipping');
            continue;
          }
          if (cfg.enrich.enrich_via_bridge && pdpFetched < cfg.enrich.max_detail_per_scan) {
            try {
              const pdpRes = await transport.request({
                method: 'GET',
                url: listing.url,
                signal: ctx.signal,
                logger: ctx.logger,
                timeoutMs: 30_000,
              });
              if (pdpRes.status >= 200 && pdpRes.status < 300) {
                listing = mergePdpIntoListing(listing, extractDetail(pdpRes.body));
              } else {
                ctx.logger.warn(
                  { url: listing.url, status: pdpRes.status },
                  'immoscout24: PDP fetch non-2xx; emitting SRP-only',
                );
              }
              pdpFetched += 1;
            } catch (err) {
              ctx.logger.warn(
                { url: listing.url, err: (err as Error).message },
                'immoscout24: PDP fetch failed; emitting SRP-only',
              );
            }
          }
          yield listing;
        }

        if (!result.hasNextPage) break;
        if (result.listings.length < result.itemsPerPage) break;
        if (page < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
      }
    } finally {
      if (activeTransport === transport) activeTransport = undefined;
      if (transport.close) await transport.close();
    }
  },
  async dispose() {
    if (activeTransport?.close) await activeTransport.close();
    activeTransport = undefined;
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
```

- [ ] **Step 2: Build the plugin to surface any type errors**

Run: `pnpm --filter @wabe/source-immoscout24 typecheck`
Expected: no errors. If `RawListing` field shapes drift, fix `map.ts` accordingly.

- [ ] **Step 3: Run the full plugin test suite**

Run: `pnpm --filter @wabe/source-immoscout24 test`
Expected: all green (errors / search / parse / map / transport / client / enrich).

- [ ] **Step 4: Commit**

```bash
git add plugins/source-immoscout24/src/index.ts
git -c commit.gpgsign=true commit -S -m "feat(is24): plugin orchestrator (paginate SRP via bridge, optional PDP enrichment)"
```

---

## Task 13: Wire cross-cutting renames

**Files:**
- Modify: `packages/core/src/canonical-key.ts:56`
- Modify: `packages/core/test/canonical-key.test.ts`
- Modify: `packages/cli/src/commands/doctor.ts:11`
- Modify: `plugins/notifier-telegram/src/card.ts:19`
- Modify: `plugins/notifier-telegram/test/card.test.ts`
- Modify: `examples/zurich-family/config/config.yaml`
- Move + rewrite: `examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml` → `source-immoscout24.yaml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rename in `canonical-key.ts`**

Edit `packages/core/src/canonical-key.ts:56`:
```ts
  'source-immoscout24-sitemap': 70,
```
→
```ts
  'source-immoscout24': 70,
```

- [ ] **Step 2: Rename in `canonical-key.test.ts`**

Find:
```ts
    expect(SOURCE_PRIORITY_DEFAULTS['source-immoscout24-sitemap']).toBe(70);
```
Replace with:
```ts
    expect(SOURCE_PRIORITY_DEFAULTS['source-immoscout24']).toBe(70);
```

- [ ] **Step 3: Rename in `doctor.ts:11`**

Find:
```ts
const DATADOME_SOURCES = ['source-homegate', 'source-immoscout24-sitemap'] as const;
```
Replace with:
```ts
const DATADOME_SOURCES = ['source-homegate', 'source-immoscout24'] as const;
```

- [ ] **Step 4: Rename in `notifier-telegram/src/card.ts:19`**

Inside the `PREVIEW_SUPPRESS_SOURCES` Set, replace `'source-immoscout24-sitemap'` with `'source-immoscout24'`.

- [ ] **Step 5: Rename in `notifier-telegram/test/card.test.ts`**

Find the test "disablePreview=true for DataDome-walled sources (IS24 sitemap)" and update both the test name (drop "sitemap") and the `source` literal.

- [ ] **Step 6: Rename in `config.yaml`**

In `examples/zurich-family/config/config.yaml`:
```yaml
    - {name: immoscout24-sitemap, plugin: source-immoscout24-sitemap,  config: plugins/source-immoscout24-sitemap.yaml}
```
→
```yaml
    - {name: immoscout24-zurich, plugin: source-immoscout24,  config: plugins/source-immoscout24.yaml}
```

And update the bridge comment block to say `source-immoscout24` instead of `source-immoscout24-sitemap`.

- [ ] **Step 7: Move + rewrite the example plugin config**

Run: `git mv examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml examples/zurich-family/config/plugins/source-immoscout24.yaml`

Replace its contents with the new schema:

```yaml
schedule: '*/15 * * * *'
search:
  language: en
  zipcodes: [8001, 8002, 8003, 8004, 8005, 8006, 8008, 8032]
  price_max: 4500
  rooms_min: 3
  surface_min: 80
  has_elevator: true
fetch:
  max_pages: 5
  pace_ms: 2500
enrich:
  enrich_via_bridge: false
  max_detail_per_scan: 40
```

- [ ] **Step 8: Update `README.md`**

In `README.md`, find every `source-immoscout24-sitemap` and replace with `source-immoscout24`. In the data-flow ASCII diagram (around `:146`), change `immoscout24-sitemap` to `immoscout24`. In the bridge section (`:173`), update the description: drop the "URL-only sitemap entries" line and replace with "paginates SRP HTML through the bridge for full-detail listings; PDP enrichment for contact channels is opt-in".

- [ ] **Step 9: Update `CLAUDE.md`**

In `CLAUDE.md`, find the line under "Repository overview" listing the source plugins and update `ImmoScout24 sitemap` → `ImmoScout24`. In the "Browser bridge" section, drop the `source-immoscout24-sitemap` mention.

- [ ] **Step 10: Run the affected test packages**

```bash
pnpm --filter @wabe/core test canonical-key.test.ts
pnpm --filter @wabe/notifier-telegram test card.test.ts
```
Expected: green.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/canonical-key.ts \
       packages/core/test/canonical-key.test.ts \
       packages/cli/src/commands/doctor.ts \
       plugins/notifier-telegram/src/card.ts \
       plugins/notifier-telegram/test/card.test.ts \
       examples/zurich-family/config/config.yaml \
       examples/zurich-family/config/plugins/source-immoscout24.yaml \
       README.md CLAUDE.md
git -c commit.gpgsign=true commit -S -m "refactor: rename source-immoscout24-sitemap → source-immoscout24 across repo"
```

---

## Task 14: Add DB migration to drop orphan sitemap_state row

**Files:**
- Create: `packages/db/migrations/0004_drop_is24_sitemap_state.sql`

- [ ] **Step 1: Write the migration**

```sql
DELETE FROM sitemap_state WHERE source = 'source-immoscout24-sitemap';
```

- [ ] **Step 2: Verify the migration loader picks it up**

Run: `pnpm --filter @wabe/db test 2>&1 | tail -20`
Expected: green; migration list now includes `0004_drop_is24_sitemap_state`.

If `@wabe/db` has no migration discovery test, instead run the integration startup:
```bash
WABE_DATA_DIR=$(mktemp -d) pnpm wabe migrate
```
Expected: `Applied migration: 0004_drop_is24_sitemap_state.sql` (or equivalent log).

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0004_drop_is24_sitemap_state.sql
git -c commit.gpgsign=true commit -S -m "db: drop orphan sitemap_state row for source-immoscout24-sitemap"
```

---

## Task 15: Rewrite plugin `README.md`

**Files:**
- Modify: `plugins/source-immoscout24/README.md`

- [ ] **Step 1: Replace the file contents**

```markdown
# @wabe/source-immoscout24

Search-based source plugin for [ImmoScout24.ch](https://www.immoscout24.ch).
Paginates the SRP (search-result page) through the Wabe browser bridge and
emits one `Listing` per result — rooms, price, surface, photos, description,
geo, all from the SRP card. Optional PDP enrichment fills contact channels
(phone / email / form URL) on opt-in.

## Requirements

DataDome + Cloudflare protect every IS24 dynamic surface. The Wabe browser
bridge is the only viable transport: in-process when running inside
`wabe start`, or via the daemon's `/dispatch` when run as a sibling CLI
process. Without a bridge the plugin fails fast at init.

See `docs/research/2026-05-18-immoscout24-investigation.md` for the
DataDome / Cloudflare investigation.

## Config

```yaml
schedule: '*/15 * * * *'
search:
  language: en               # de | fr | it | en
  zipcodes: [8001, 8032]     # 1 zip → city-slug if known, else wzip param; multi-zip → joined wzip
  price_min: 1500
  price_max: 4500
  rooms_min: 3
  surface_min: 80
  has_elevator: true
  sort_by: dateCreated       # dateCreated | price | roomCount | livingSpace
  sort_direction: desc
fetch:
  max_pages: 5
  pace_ms: 2500
  backoff:
    on: [429, 500, 502, 503, 504]
    retries: 3
    base_ms: 2000
enrich:
  enrich_via_bridge: false   # opt-in: fetch each PDP for contact channels
  max_detail_per_scan: 40
```

## Why no PDP by default

The SRP card already carries rooms, price, surface, photos, description, geo,
title, and most characteristics. PDP fetches only add phone / email / agency
legal name — useful for some users, costly in bridge round-trips for others.
Default off; opt in with `enrich.enrich_via_bridge: true`.

## Tests

`pnpm --filter @wabe/source-immoscout24 test`

The captured SRP fixture under `test/fixtures/srp-zurich-page1.html` exercises
`parse.ts`, `map.ts`, and `enrich.ts` without live network access.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/source-immoscout24/README.md
git -c commit.gpgsign=true commit -S -m "docs(is24): rewrite plugin README for SRP-based design"
```

---

## Task 16: Integration sanity check + repo-wide CI

- [ ] **Step 1: Run the full workspace build**

Run: `pnpm build`
Expected: every package builds cleanly.

- [ ] **Step 2: Run the full workspace test suite**

Run: `pnpm test`
Expected: every test green. If the server integration test in `packages/server` relies on a stubbed `source-immoscout24-sitemap`, swap the stub source name to `source-immoscout24` and re-run.

- [ ] **Step 3: Run `pnpm ci`**

Run: `pnpm ci`
Expected: lint + format-check + typecheck + test all green.

- [ ] **Step 4: Local live smoke against the running bridge daemon**

Confirms the renamed plugin end-to-end against IS24 through the live bridge.

Run:
```bash
pnpm wabe scan --source source-immoscout24 --config examples/zurich-family/config/config.yaml --dry-run 2>&1 | tail -40
```
Expected: bridge transport selected, 5 pages fetched, ~100 listings parsed + mapped, no DataDome errors, no PDP fetches (enrich off by default).

- [ ] **Step 5: Live smoke with PDP enrichment on**

Edit `examples/zurich-family/config/plugins/source-immoscout24.yaml` temporarily: set `enrich.enrich_via_bridge: true` and `enrich.max_detail_per_scan: 3`. Re-run the scan:
```bash
pnpm wabe scan --source source-immoscout24 --config examples/zurich-family/config/config.yaml --dry-run 2>&1 | grep -E 'immoscout24|contact|agency' | head
```
Expected: at least 3 PDP fetches logged, at least one listing with a non-empty `contact` / `agency`. Revert the config edit after verifying.

- [ ] **Step 6: Commit any test-side renames + push the branch**

```bash
git status --porcelain
# If the server integration test or other suite picked up new edits during the run, commit them:
git add -A
git -c commit.gpgsign=true commit -S -m "test: align server integration stubs with renamed source"
git push -u origin source-immoscout24-search
```

---

## Self-Review

**1. Spec coverage**

| Spec section / requirement                                                 | Task                            |
|----------------------------------------------------------------------------|---------------------------------|
| Package rename, drop fast-xml-parser                                       | Task 3                          |
| Delete sitemap/state code path                                             | Task 4                          |
| `SearchConfig` mirrors homegate                                            | Task 6                          |
| URL builder + city-slug + wzip + filters + sort                            | Task 6 (+ Task 2 input)         |
| Bridge transport selection (in-proc → daemon → hard fail)                  | Task 9                          |
| Pacing + retries + 403 → IS24AntiBotError + abort handling                 | Task 5, Task 10                 |
| Parse `__INITIAL_STATE__` + Zod-validate listings array                    | Task 7                          |
| Map SRP card → RawListing (all fields in the spec table)                   | Task 8                          |
| Opt-in PDP enrichment: contact-only merge, no SRP overwrite                | Task 11, Task 12                |
| Orchestrator: page loop, pacing, PDP cap, lifecycle close                  | Task 12                         |
| No per-source state (rely on server dedupe)                                | Task 4 (deletes state.ts), Task 12 (no state read/write) |
| Migration dropping orphan sitemap_state row                                | Task 14                         |
| Cross-cutting renames (server / core / cli / notifier / examples / README) | Task 13                         |
| Plugin README rewrite                                                      | Task 15                         |
| Bridge load model + worst-case math                                        | Documented in spec, covered by Task 16 smoke |
| Open verification items (filter param names, multi-zip, PDP shape)         | Resolved in Task 2; fed into Tasks 6, 11 |
| Tests with captured fixture; no live network in CI                         | Tasks 7, 8, 11; CI guarded by Task 16 |
| Live smoke against running daemon                                          | Task 16 Steps 4-5               |

No gaps.

**2. Placeholder scan**

- Task 6's URL-param names are conditional on Task 2 — the plan explicitly says "swap in the verified names". Not a placeholder; it's a planned parameter, fully realized once Task 2 outputs are folded in.
- Task 11 notes "extend `detail.ts` if Task 2 shows PDP carries contact under different keys" — same pattern. Concrete enough to act on.
- No "TBD", "TODO", "implement later", or "similar to Task N" anywhere.

**3. Type consistency**

- `SearchConfig` defined in Task 6 with fields `zipcodes / price_min / price_max / rooms_min / rooms_max / surface_min / property_type / offer_type / has_balcony / has_elevator / sort_by / sort_direction / language` — same names used in Tasks 12, 13, 15.
- `Transport` interface (`kind / request / close?`) defined in Task 9, used consistently in Tasks 10 and 12.
- `FetchContext` in Task 10 (`paceMs / backoff / signal / logger / transport`) matches what Task 12 passes.
- `IS24SrpListing` type from Task 7 is the argument type to `mapSrpListing` in Task 8.
- `RawListing` field names (`source / id / url / price.total / rooms / area_m2 / location.coords / location.postal_code / contact / enriched / agency / features / extra`) match `@wabe/core`'s actual schema as observed in `plugins/source-homegate/src/map.ts`.
- `DetailPayload` from `detail.ts` is the argument type to `mergePdpIntoListing` in Task 11; `detail.ts` itself stays intact from the existing plugin.
- `mapSrpListing(card, primaryLang)` signature in Task 8 is called as `mapSrpListing(card, cfg.search.language)` in Task 12 — types align (`'de'|'en'|'fr'|'it'`).
- `mergePdpIntoListing(listing, pdp)` in Task 11 is called the same way in Task 12.

No name drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-immoscout24-search-source.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
