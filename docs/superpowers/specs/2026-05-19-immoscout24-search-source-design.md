---
date: 2026-05-19
status: design
topic: ImmoScout24 search-based source plugin (replaces sitemap)
supersedes:
  - plugins/source-immoscout24-sitemap (rename + rewrite)
related:
  - docs/research/2026-05-18-immoscout24-investigation.md
  - docs/superpowers/specs/2026-05-18-homegate-source-and-oauth-design.md
  - docs/superpowers/specs/2026-05-19-bridge-keepalive-and-fanout-design.md
---

# Search-based `source-immoscout24` (replaces sitemap plugin)

## Goal

Replace `@wabe/source-immoscout24-sitemap` with `@wabe/source-immoscout24`: a
paginated SRP scanner that routes HTTPS through the Wabe browser bridge —
analogous to `@wabe/source-homegate` — and emits full-detail listings without
needing a per-listing PDP fetch in the common case.

The sitemap discovery path is dropped entirely. The plugin is renamed in place,
existing dedup / state rows for the old name are cleaned up via migration.

## Why this matters

The sitemap plugin emitted URL-only listings (rooms / price / area / description
all `null`) unless the bridge was paired AND `enrich_via_bridge: true` AND
`max_detail_per_scan` allowed the PDP fetch. That made the OOB experience poor:
sitemap diff produced a stream of empty cards on first scan, and PDP enrichment
duplicated the bridge round-trips already needed.

Live capture against `https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G`
(2026-05-19, via daemon bridge) shows the SRP page embeds the full listing
result-set in `window.__INITIAL_STATE__.resultList.search.fullSearch.result.listings[]`
— 20 listings per page with rooms / price / area / photos / description /
geocoordinates / cross-portal flags. One round trip per page replaces 20.

## Non-goals

- Mobile API surface (`api.immoscout24.ch`) — still IP-locked S3; out of scope.
- Email saved-search alerts ingestion — separate future spec.
- Cross-portal dedup using `platforms[]` — stored in `enriched.cross_listed_on`
  for future heuristics, but not consumed by canonical-key.
- IS24 BUY listings. RENT only, same as current.
- **One-row-per-logical-listing collapse across sources.** Today the `listings`
  table holds one row per (source, listing) pair joined by `canonical_key`;
  `shouldNotify` dedups notifications cross-source but not DB rows.
  Collapsing to one row per `canonical_key` (with second-source arrivals
  enriching the existing row) is a project-wide refactor — separate spec,
  not a blocker for this plugin.

## Architecture

### Discovery flow

```
SearchConfig ─► buildSrpUrl(cfg, page) ─► fetchSrp(url, transport, pacing) ─► extractInitialState(html)
                                                                                       │
                                                                                       ▼
                                                                       result.listings[] (size 20)
                                                                                       │
                                                          ┌────────────────────────────┴────────────────────────────┐
                                                          ▼                                                          ▼
                                              mapSrpListing(card, lang)                         opt-in: fetch PDP via transport
                                                          │                                                          │
                                                          ▼                                                          ▼
                                                  Listing (SRP-only)         ◄── merge contact-only ── extractDetail(html)
                                                          │
                                                          ▼
                                                    yield to pipeline
```

### Transport selection

Identical pattern to `@wabe/source-homegate`'s `selectTransport({ dataDir, logger })`:

1. In-process bridge via `getCurrentBridge()` (when running inside `wabe start`).
2. Daemon bridge via `DaemonBridgeTransport.tryConnect(dataDir)` (sibling CLI process).
3. **Hard fail at init** when neither is available. DataDome blocks every direct
   request — no useful fallback exists. The plugin does NOT degrade to URL-only
   (the sitemap plugin's old fallback) because there is no longer a sitemap
   discovery surface to fall back to.

### Pagination

- One SRP request per page. `page_size` is fixed at 20 (IS24-side, not
  configurable). Plugin emits `pn=1`, `pn=2`, … until any of:
  - `result.hasNextPage === false`
  - `page > cfg.fetch.max_pages`
  - `result.listings.length === 0`
- Pacing: `cfg.fetch.pace_ms` (default 2500) between page requests.
- Retry / backoff: same shape as homegate's `client.ts` (`on: [429,500,502,503,504]`,
  `retries: 3`, `base_ms: 2000`).

## Plugin config schema

```ts
const SearchConfig = z.object({
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

const FetchConfig = z.object({
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2500),
  backoff: z.object({
    on: z.array(z.number()).default([429, 500, 502, 503, 504]),
    retries: z.number().int().nonnegative().default(3),
    base_ms: z.number().int().positive().default(2000),
  }).default({}),
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
```

`SearchConfig` deliberately mirrors `@wabe/source-homegate`'s shape so users can
copy a typed filter set between sources without re-learning param names.

## URL builder

```ts
buildSrpUrl(cfg: SearchConfig, page: number): string
```

- Base: `https://www.immoscout24.ch/<language>/real-estate/rent/<location>`.
- `<location>`:
  - 0 zipcodes → root path: `/<language>/real-estate/rent`.
  - 1 zipcode → `city-<slug>` if a known mapping exists, else fall back to root
    + query-param zip filter. Mapping table verified at plan capture (see
    "Open verification items" below). Worst case: root path + zip filter.
  - 2+ zipcodes → root path; emit one URL per zipcode OR pass them via a
    multi-zip query param (verified at plan capture). If neither path is clean,
    fall back to per-zip fan-out with shared pacing budget.
- Always: `?an=G` (sitemap allowlist marker; also IS24's "all listings" query).
- Pagination: `&pn=<page>`.
- Filters: `&ps=<price_min>&pe=<price_max>&nrf=<rooms_min>&nrt=<rooms_max>&slf=<surface_min>`
  — assumed param names. **EXACT NAMES VERIFIED AT PLAN CAPTURE**; see open
  verification items.
- Sort: `&srt=<sort_by>&sdt=<sort_direction>` — assumed; verified at capture.

## SRP parser

```ts
extractInitialState(html: string): IS24InitialState | null
```

- Regex-extracts the `window.__INITIAL_STATE__ = {...};</script>` blob.
- `JSON.parse`s it.
- Validates the `resultList.search.fullSearch.result` subtree against a Zod
  schema (`IS24SearchResultSchema`) before returning. Schema errors → log warn,
  return `null` (caller skips page, doesn't crash).
- Per-listing shape under `.result.listings[]` validated by a strict
  `IS24SrpListingSchema` (Zod). Bad entries are skipped with a warn, not fatal.

## Mapper

`mapSrpListing(card, lang): Listing | null`

| Listing field          | SRP source                                                                    |
|------------------------|-------------------------------------------------------------------------------|
| `source`               | literal `'source-immoscout24'`                                                |
| `external_id`          | `card.id` (numeric string, e.g. `'4002086198'`)                               |
| `url`                  | `https://www.immoscout24.ch/rent/<id>` (canonical PDP URL)                    |
| `title`                | `card.listing.localization[lang].text.title`                                  |
| `description`          | `card.listing.localization[lang].text.description`                            |
| `rooms`                | `card.listing.characteristics.numberOfRooms`                                  |
| `area_m2`              | `card.listing.characteristics.livingSpace`                                    |
| `price`                | `card.listing.prices.rent.gross`                                              |
| `price_currency`       | `card.listing.prices.currency`                                                |
| `address.street`       | `card.listing.address.street`                                                 |
| `address.postal_code`  | `card.listing.address.postalCode`                                             |
| `address.locality`     | `card.listing.address.locality`                                               |
| `address.geo.lat/lon`  | `card.listing.address.geoCoordinates.{latitude,longitude}`                    |
| `photos`               | `card.listing.localization[lang].attachments[]` where `type === 'IMAGE'`     |
| `posted_at`            | `card.listing.meta.createdAt`                                                 |
| `agency`               | `null` from SRP (populated from PDP when enrichment on)                       |
| `contact`              | `{}` from SRP (PDP fills phone/email/form_url when enrichment on)             |
| `enriched.lister.logo_url` | `card.listerBranding.logoUrl`                                              |
| `enriched.cross_listed_on` | `card.listing.platforms[]` (cleaned, lowercased, deduped)                  |
| `enriched.is24.listing_type` | `card.listingType.type` (`PREMIUM`/`STANDARD` — useful signal)            |
| `enriched.is24.subscription_type` | `card.listerBranding.subscriptionType`                                |

Per the cross-source convention: `contact` accepts only `phone / email /
form_url`. Anything richer lands in `enriched.lister`.

## Opt-in PDP enrichment

When `enrich.enrich_via_bridge === true`:

- For each *new* listing (not already in `dedup_state`), if
  `pdpFetched < enrich.max_detail_per_scan`:
  - GET `card.url` via the same bridge transport (no new connection).
  - `extractDetail(html)` (reused from current `detail.ts`).
  - Merge PDP fields **only into contact-shaped gaps**:
    - `contact.phone / .email / .form_url`
    - `agency` (when `null` from SRP)
    - `enriched.lister.{legal_name, website, inquiry_contact, viewing_contact, address_locality}`
  - **Never overwrite SRP fields** (SRP is authoritative for rooms / price /
    area / description / photos / geo).
- PDP fetch failure: log warn, emit SRP-only listing.
- Default off: most users only care about the listing card; opting in trades a
  bridge round-trip per new listing for contact-channel coverage.

## State / dedup

The plugin holds **no per-source state**. It emits every result on every scan;
the server's pipeline (`packages/server/src/dedupe.ts`) dedups via the
`listings` table's `canonical_key`. New rows fire notifications; matched rows
suppress them. This matches `@wabe/source-homegate` exactly.

Migration cleanup: the old `sitemap_state` row for `source-immoscout24-sitemap`
is orphaned. Drop it via a new migration
`packages/db/migrations/NNNN_drop_is24_sitemap_state.sql`. The `sitemap_state`
table itself stays (no other consumers; harmless).

First-scan behavior: every listing across `max_pages` is new → all fire
notifications. Same trade-off as homegate. Users who want to suppress the
first flood can run `wabe scan --source source-immoscout24` once before
enabling the schedule, or temporarily lower `fetch.max_pages` for the seed
scan.

## File layout

```
plugins/source-immoscout24/
├── package.json              # @wabe/source-immoscout24
├── README.md
├── src/
│   ├── index.ts              # plugin factory, transport selection, fetch loop, lifecycle
│   ├── search.ts             # SearchConfig schema + buildSrpUrl(cfg, page)
│   ├── client.ts             # fetchSrp(url, transport, pacing, backoff, signal, logger)
│   ├── parse.ts              # extractInitialState(html) + Zod schemas
│   ├── map.ts                # mapSrpListing(card, lang) → Listing
│   ├── detail.ts             # KEEP existing PDP extractor (opt-in enrichment)
│   ├── enrich.ts             # mergePdpIntoListing(listing, pdpPayload) — contact-only merge
│   └── transport.ts          # selectTransport({dataDir, logger}) — clone of homegate's
└── test/
    ├── parse.test.ts         # captured SRP fixture → extractInitialState
    ├── map.test.ts           # card → Listing
    ├── search.test.ts        # SearchConfig → URL
    ├── enrich.test.ts        # SRP listing + PDP payload merge rules
    └── fixtures/
        ├── srp-zurich-page1.html      # ~760 KB live capture, secrets redacted
        └── pdp-sample.html            # one PDP capture for enrich tests
```

## Cross-cutting renames

| File | Change |
|------|--------|
| `packages/server/package.json:24` | replace `@wabe/source-immoscout24-sitemap` with `@wabe/source-immoscout24` |
| `packages/core/src/canonical-key.ts:56` | rename `'source-immoscout24-sitemap'` → `'source-immoscout24'`, keep weight `70` |
| `packages/core/test/canonical-key.test.ts` | rename literal in test |
| `packages/cli/src/commands/doctor.ts:11` | rename in `DATADOME_SOURCES` |
| `plugins/notifier-telegram/src/card.ts:19` | rename source label |
| `plugins/notifier-telegram/test/card.test.ts` | rename in test |
| `examples/zurich-family/config/config.yaml:10,21` | rename plugin entry + comment |
| `examples/zurich-family/config/plugins/source-immoscout24-sitemap.yaml` | rename file → `source-immoscout24.yaml`, rewrite contents for new schema |
| `README.md:146,173` | rename source label, update description (search-based, bridge-required, no URL-only fallback) |
| `pnpm-lock.yaml` | regenerated by `pnpm install` after package rename |

## Migration

New file: `packages/db/migrations/NNNN_drop_is24_sitemap_state.sql`:

```sql
DELETE FROM sitemap_state WHERE source = 'source-immoscout24-sitemap';
```

Idempotent. Applied at startup by `wabe migrate` / `scan` / `start` (existing
machinery).

## Testing

- `parse.test.ts` — captured SRP fixture → assert `extractInitialState` returns
  `.result.listings.length === 20`, asserts pagination metadata round-trips.
- `map.test.ts` — sample card from fixture → assert Listing fields populated as
  per mapper table above; asserts `agency === null` and `contact === {}` from
  SRP-only path.
- `search.test.ts` — covers URL builder for: empty zipcodes (root URL), single
  zipcode (city slug fallback to root + zip-filter), multi-zipcode fan-out,
  combined filters.
- `enrich.test.ts` — SRP listing + PDP payload → assert merge fills only
  `contact / agency / enriched.lister.*`; asserts SRP fields preserved when
  PDP carries conflicting values.
- `index.test.ts` (in `packages/server`) — integration: stub transport returns
  fixture HTML, assert pipeline produces N listings with expected dedup
  behavior on second scan.

**No live network calls in CI.** Fixtures captured live and committed.

## Bridge load model

Per scheduled scan, with default config (`max_pages: 5`, `enrich_via_bridge: false`):

- 5 bridge requests per scan (one per page).
- At default `*/15 * * * *` schedule: ~20 bridge requests / hour from IS24.

With `enrich_via_bridge: true` and `max_detail_per_scan: 40`:

- 5 SRP requests + up to 40 PDP requests = 45 bridge requests per scan worst case.
- At `*/15 * * * *`: 180 bridge requests / hour worst case. Same order of
  magnitude as homegate at `max_pages: 5`.

Compared to old sitemap plugin's worst-case enriched scan: 1 sitemap-index fetch
+ N leaf-sitemap fetches + up to `max_detail_per_scan` PDP fetches. New plugin
removes the sitemap-leaf chatter entirely.

## Open verification items (resolved at plan capture, not blockers)

Each item below is resolved by capturing one or two SRP responses through the
daemon bridge during the plan phase. None of them affects the design shape;
they fix concrete URL strings.

1. **Filter query-param names**. Confirm `ps / pe / nrf / nrt / slf` (assumed)
   by toggling each filter in the IS24 UI and capturing the resulting URL.
2. **Sort query-param names**. Confirm `srt / sdt` (assumed) similarly.
3. **Single-zipcode mapping**. Determine whether `city-<slug>` works for
   arbitrary Swiss zips, or whether the canonical form is `r=<region-id>` /
   query-param zip filter. Capture two zipcodes (one urban, one rural) and
   compare URL shapes.
4. **Multi-zipcode handling**. Test whether a single SRP URL accepts multiple
   zip filters or whether per-zip fan-out is required. If fan-out is needed,
   adjust pagination budget logic accordingly.
5. **PDP `__NEXT_DATA__` shape**. The current `detail.ts` was written
   speculatively. Capture one PDP through the bridge and confirm the JSON path
   the mapper expects (`pageProps.* → numberOfRooms / grossPrice / lister`).
   Update `detail.ts` / `enrich.ts` if the shape differs.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| IS24 changes `__INITIAL_STATE__` key path | Zod schema at parse boundary fails loudly; failure logs include the actual shape so the mapper can be updated quickly. |
| DataDome rule update breaks bridge transport | Same risk surface as homegate; bridge handles DataDome via genuine page context, so any breakage hits both plugins together. Monitored via plugin circuit breaker. |
| First scan emits 100s of cards into Telegram | Same trade-off as homegate. Users can run a seed scan with low `max_pages` before enabling the schedule. |
| PDP enrichment bridge floods | `max_detail_per_scan: 40` cap + opt-in default off. |
| Bridge daemon down between scheduled scans | Plugin hard-fails at init in that scan (logged); next scheduled tick retries. No state mutation on hard-fail. |
| `listings` table accumulates IS24 rows indefinitely | Same as existing sources; future spec can add a TTL/garbage-collection pass. Out of scope here. |

## Rollout

Single PR. No phased rollout — clean rename + replace. Migration runs at first
boot post-merge.
