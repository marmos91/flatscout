# Multi-source expansion — design

**Date:** 2026-05-18
**Status:** Design — awaiting implementation plan(s)
**Branch target:** main (each phase gets its own feature branch off main)

## 1. Problem

Wabe ships one source (`@wabe/source-flatfox`) and a deferred Homegate source. Coverage of the Swiss rental market is incomplete. A research spike (2026-05-18) probed nine candidate sources to identify the next batch worth shipping. This spec consolidates the findings into three independent workstreams that can ship in order.

The probes are recorded in `docs/research/2026-05-18-*-investigation.md`.

## 2. Research summary (ranked by ROI × ease)

| Rank | Source | Ease | Unique inventory | Verdict |
|------|--------|------|------------------|---------|
| 1 | realadvisor.ch | trivial (anonymous REST `/api/listings`) | aggregator overlap | ship in Phase A |
| 2 | immoscout24.ch sitemap | easy (gz XML diff, no anti-bot) | high (top-3 CH portal) | ship in Phase A as URL-only |
| 3 | immobilier.ch | easy (HTML + JSON-LD, no anti-bot) | high (Romandie focus) | ship in Phase A |
| 4 | homegate.ch (extension) | medium (extension build) | high | Phase B pivot from Playwright |
| 5 | immoscout24.ch (extension) | reuse Phase B infra | full detail | comes free with Phase B |
| 6 | engelvoelkers.com | trivial (anonymous BFF) | tiny (8 ZH listings) | opt-in luxury, deferred |
| 7 | housinganywhere.com | trivial (leaked Algolia key) | niche (87 monthly ZH) | opt-in expat, deferred |
| 8 | comparis.ch | hard (DataDome wall + strips canonical IDs) | aggregator | skip |
| 9 | alle-immobilien.ch | n/a | SMG satellite, no own inventory | skip |
| 10 | home.ch | n/a | literal Homegate skin (`api.homegate.ch?pub=home`) | skip — covered by homegate plugin |
| 11 | realestate.com.au/intl/ch | medium | derivative + ToS bans aggregators + AI bots | skip |

## 3. North-star architecture (post-A+B+C)

```
                                ┌─ source-flatfox          (shipped, REST)
                                ├─ source-realadvisor      (Phase A, REST)
       ┌─ pure-undici plugins ──┼─ source-immobilier-ch    (Phase A, HTML+JSON-LD)
       │                        ├─ source-immoscout24      (Phase A: sitemap-only → Phase B: full detail via bridge)
       │                        └─ source-engelvoelkers /  (deferred, opt-in)
       │                           source-housinganywhere
       │
wabe ──┼─ browser-bridge plugins ─ source-homegate         (Phase B: extension-first, Playwright fallback)
       │                          source-immoscout24       (Phase B: upgrades to bridge)
       │
       └─ agency family adapters ─ source-schemaorg         (Phase C, generic JSON-LD fallback)
                                   source-immomig          (Phase C tier-2, conditional)
                                   source-casasoft          (Phase C tier-2, conditional)
                                   ↑ driven by user-provided agencies.yaml registry

Cross-cutting (Phase A scope, used by all):
  - Dedup pipeline: canonical_key + source_priority on Listing
  - Source-attribution: "shown on N portals" badge in notifier card
  - Browser-bridge runtime (Phase B): WebSocket server in wabe + manifest-v3 extension
```

## 4. Phase A — Wave 1 sources + dedup

**Goal:** Ship three new pure-undici sources behind a dedup pipeline so notifications do not spam duplicates as the source count grows.

### 4.1 New plugin packages

- `plugins/source-realadvisor` — `@wabe/source-realadvisor`. REST `GET https://realadvisor.ch/api/listings` with `offerType_eq`, `compositePropertyType_eq`, `placeSlugs` (JSON array), `*_lte/_gte` range filters, `sort=created_at_desc`, `page=N` (1-based, 36/page). Response carries `total_count` for pagination. Maps to `Listing`. undici Pool, polite pacing, 429/5xx backoff. Mock-fixture tests. README documents aggregator caveat (encrypted clickout URLs hide original source portal; dedup handles overlap at Wabe level).
- `plugins/source-immoscout24-sitemap` — `@wabe/source-immoscout24-sitemap`. Fetch `/sitemap/sitemap.xml`, follow `pdp-N-sitemap-RENT-<lang>.xml.gz`, gunzip, diff URL set against previous scan (state in SQLite). New URLs emit `Listing` with `url`, `lastmod`, `thumbnail`, and `geo` (postal_code/locality/canton) extracted from `<image:geo_location>`. Detail fields (`rooms`, `area_sqm`, `price`, `description`) remain `null` until Phase B promotes this plugin to full-detail via the browser bridge.
- `plugins/source-immobilier-ch` — `@wabe/source-immobilier-ch`. Driven by `sitemap/rents.xml` `lastmod` for incremental scans. Detail-page `GET` parses JSON-LD blocks (`@type: Product` with `Offers.Price`, `@type: Residence` with `streetAddress`/`addressLocality`/`postalCode`) into `Listing`. Honors site-stated 5s `Crawl-delay` via undici Pool pacing. Config exposes `cantons` filter; users targeting Zurich only can drop the heavy Romandie inventory (Geneva ~993 / Lausanne ~500 / Zurich ~220 / Bern ~45 at probe time).

All three follow existing `@wabe/source-flatfox` conventions: their own Zod config schema, their own README, their own vitest suite with undici MockAgent + captured fixtures under `package/test/fixtures/responses/`.

### 4.2 Cross-cutting schema + pipeline work (Phase A scope, prerequisite for the three plugins)

- `packages/core/src/schemas/listing.ts` adds:
  - `canonical_key: string` — sha256 of bucketed dedup fields.
  - `source_priority: number` (0–100) — higher wins on dedup tie.
  - `seen_on_sources: string[]` — merged list across deduped duplicates.
  - `first_seen_at: ISO datetime`, `last_seen_at: ISO datetime`.
- `packages/db/migrations/0005_dedup_fields.sql` — add columns, default `source_priority` from new defaults table. Existing rows backfilled on next scan (idempotent).
- `packages/server/src/dedup.ts` — new pipeline stage between enrich and score. Groups listings by `canonical_key`. Keeps highest-priority entry per group. Merges `seen_on_sources`.
  - Bucket function: `rooms_bucket = round(rooms*2)/2`, `area_bucket = round(area/5)*5`, `price_bucket = round(price/50)*50`.
  - `canonical_key = sha256(postal_code + "|" + rooms_bucket + "|" + area_bucket + "|" + price_bucket)`.
  - Listings missing any bucket field (e.g., IS24 sitemap with no rooms/price) get a unique key (sha256 of the listing URL) and never collapse against detailed listings. Accepted trade: false negatives over false positives.
- `packages/server/src/pipeline.ts` — wire dedup into fetch → enrich → **dedup** → score → notify.
- `packages/core/src/source-priority.ts` — default priority table (overridable per source via `sources[].priority` in user yaml):
  - agency-direct (Phase C) = 100
  - flatfox = 80
  - homegate / immoscout24 = 70
  - immobilier = 70
  - realadvisor = 50 (aggregator)
  - engelvoelkers / housinganywhere = 30 (opt-in tertiary)
- `plugins/notifier-telegram/src/card.ts` — when `seen_on_sources.length > 1`, render footer `Also on: <sources>`. Primary URL is the winning source's URL. Secondary URLs become additional inline buttons where Telegram permits.

### 4.3 Phase A out of scope

- IS24 full detail (deferred to Phase B browser bridge).
- Agency adapters (Phase C).
- Address-normalization library / fuzzy street-name match (defer; bucket-based dedup is good enough for v1).
- Geographic dedup across postal codes (defer).
- ML / image-hash dedup (defer).

### 4.4 Phase A success criteria

- `pnpm ci` green across the workspace.
- `wabe scan` with all three new sources enabled emits at most one Telegram card per real-world apartment over a manual one-week verification window.
- Existing Flatfox/Homegate cards render the `Also on:` footer when overlap is detected.
- `@wabe/server` integration test feeds three stub sources with overlapping listings and asserts dedup output + `seen_on_sources` merging.

## 5. Phase B — Browser extension architecture

**Goal:** Replace fragile Playwright fingerprint chase with a genuine-Chrome request proxy. Unlocks Homegate + IS24 full-detail via a single shared infra, applicable to any future DataDome-protected source.

### 5.1 Motivation

Recent commits on `feat/source-homegate` show repeated firefighting against fingerprint drift ("match bootstrap Chrome UA", "persistent context", "browser shape on API requests"). DataDome fingerprints TLS (JA3/JA4) + HTTP/2 frame order in addition to cookies and headers — undici-replayed sessions can be flagged even with valid harvested cookies. A WebExtension that executes `fetch()` from inside the user's real Chrome moves the request *into* the browser, where DataDome sees genuine human Chrome traffic.

### 5.2 New packages

- `apps/extension-wabe` — manifest v3 WebExtension (Chrome + Firefox via `browser_specific_settings`). Components:
  - Service worker: persistent WebSocket to `ws://127.0.0.1:<wabe-port>/bridge` with exponential reconnect. Authenticates with shared secret from `chrome.storage.local`. `chrome.alarms` keepalive to mitigate manifest v3 service-worker suspension.
  - Popup: connection status (connected/disconnected/last-request timestamp) + pairing flow (QR scan or one-shot token paste).
  - `host_permissions`: `*://*.homegate.ch/*`, `*://*.immoscout24.ch/*`. Future hosts added without re-publishing the extension if loaded unpacked.
- `packages/browser-bridge` — `@wabe/browser-bridge`. Server-side:
  - WebSocket server (`ws` lib) bound to `127.0.0.1` only (local-only by design; never `0.0.0.0`).
  - Request protocol: `{ id, method, url, headers, body }` → response `{ id, status, headers, body }`. In-flight request map with 30s timeout.
  - Shared-secret handshake (Ed25519 or HMAC; choose during implementation plan). Secret stored in OS keychain on the wabe side (reuses existing secret store from `feat/source-homegate`).
  - `BrowserBridgeTransport` adapter implementing the same minimal `Transport` interface as `UndiciTransport` and `PlaywrightTransport`, so source plugins switch transparently.

### 5.3 Plugin refactors

- `plugins/source-homegate/src/transport.ts` — extract `Transport` interface (`request(url, init): Promise<Response>`). Three implementations: `UndiciTransport`, `PlaywrightTransport` (current branch's code), `BrowserBridgeTransport`. Runtime selection order: bridge if connected → playwright if browser-runtime installed → undici (anonymous-only).
- `plugins/source-immoscout24` — Phase A ships the sitemap-only version. Phase B adds a `BrowserBridgeTransport` path so the plugin promotes to full-detail PDPs (rooms, price, photos, description) — same `Listing` schema as Flatfox/Homegate.
- The Auth0 login path on `feat/source-homegate` (device flow + secret store + `wabe login homegate`) stays as a fallback but is no longer required: the extension automatically reads `homegate.ch` cookies after the user logs in to Homegate in the same browser.

### 5.4 CLI additions

- `wabe bridge pair` — prints pairing QR + one-time token. User installs extension unpacked, scans, paired.
- `wabe bridge status` — connection state + last request timestamp.
- `wabe doctor` — extends existing checks with bridge connectivity probe and transport-selection report per source plugin.

### 5.5 Migration / coexistence

`@wabe/browser-runtime` (Playwright + stealth, current branch) is retained as a fallback transport. Headless deployments (no GUI for the extension's Chrome) keep working via the existing Playwright path. Desktop deployments install the extension once and DataDome fingerprint problems become irrelevant for the duration of the user's logged-in session.

### 5.6 Distribution

Unpacked dev load initially (Chrome `chrome://extensions` developer mode, Firefox `about:debugging`). Chrome Web Store + AMO submission is a separate phase post-MVP (requires $5 Chrome dev fee, AMO listing, AGPL source link).

### 5.7 Phase B out of scope

- Safari / mobile (different extension model).
- Multi-user shared bridge (single-user only).
- Chrome Web Store / AMO submission.
- Comparis source (skipped regardless — aggregator strips canonical IDs).

### 5.8 Phase B success criteria

- Extension paired in under 60 seconds via QR.
- `wabe bridge status` reports `connected`.
- `wabe scan --source homegate` succeeds via bridge with no Playwright invocation.
- IS24 emits full-detail listings (rooms/price/photos), not URL-only.
- Headless fallback verified: with the extension unpaired, scans still succeed via Playwright.
- `@wabe/browser-bridge` integration test exercises ws round-trip with a mock extension client.

## 6. Phase C — Agency registry + family adapters (revised scope)

**Goal:** Capture the agency-direct long tail without bundling proprietary data. Wabe ships the mechanism (schema, loader, generic schema.org adapter, CLI). The agency registry itself is a user-provided YAML asset that can be kept private, shared friends-only, or published later under any license.

### 6.1 Why the scope is conservative

Swiss agency CMS landscape is fragmented. A discovery spike is required before committing to family-specific adapters: known families (ImmoMig, Casasoft, IAZI/Onesty, WordPress + IDX plugins) coexist with a large `custom` long tail, agencies that iframe portals (no own data — skip), and agencies that publish nothing on their own site (just post to Homegate/IS24 — out of reach). The realistic workhorse is the cross-cutting schema.org `RealEstateListing` JSON-LD surface, which many modern CMSes and bespoke sites emit as a SEO side effect.

### 6.2 Shipped in Phase C

- `packages/core/src/schemas/agency-registry.ts` — Zod schema for `AgencyRegistry`:
  ```ts
  const AgencyEntry = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    website: z.string().url(),
    canton: z.enum([...26 Swiss cantons]),
    platform: z.enum(["immomig", "casasoft", "schemaorg", "custom"]),
    feed_url: z.string().url().optional(),
    detail_url_template: z.string().optional(),
    rate_limit_per_min: z.number().int().positive().default(6),
    priority: z.number().int().min(0).max(100).default(100),
    enabled: z.boolean().default(true),
    notes: z.string().optional(),
  })
  const AgencyRegistry = z.object({
    version: z.literal(1),
    source: z.string(),
    fetched_at: z.string().datetime().optional(),
    agencies: z.array(AgencyEntry),
  })
  ```
  Export JSON Schema to `packages/core/schemas/agency-registry.schema.json` for YAML editor autocomplete.

- `packages/server/src/agency-registry.ts` — loader supporting three sources:
  - Local file path (`./agencies.yaml`).
  - HTTPS URL with optional bearer token via `${env.WABE_REGISTRY_TOKEN}` interpolation.
  - Git repo URL (`git+ssh://...#branch`) with periodic `refresh_interval` pull.
  Optional Ed25519 signature verify against a `.sig` sidecar using a pubkey configured per source.

- `packages/server/src/config-preprocessor.ts` — registry expansion stage. Pure transformation: yaml-in → `sources[]` array out. Each enabled agency row becomes a synthetic source plugin instance keyed `agency:<platform>:<id>`. Bundled family adapters resolve the platform; row fields become plugin config. Existing plugin SDK unchanged. If a registry entry references a `platform` whose adapter is not bundled in the current Wabe build (e.g., `immomig` before its tier-2 adapter ships), the preprocessor logs a structured warning, marks the entry as skipped in `wabe agencies stats`, and continues — never throws. This keeps registries forward-compatible.

- `plugins/source-schemaorg` — `@wabe/source-schemaorg`. Generic JSON-LD `RealEstateListing` scraper. Sitemap-driven discovery (config `sitemap_url`). Detail-page GET parses JSON-LD into `Listing`. Catches medium-tail bespoke sites regardless of underlying CMS.

- `packages/agency-fingerprint` — `@wabe/agency-fingerprint`. HTTP probe + heuristics for classifying an agency URL. Initial candidate signatures (subject to validation during the discovery spike — exact patterns confirmed against live sample before the package ships):
  - ImmoMig: `<meta name="generator" content*="ImmoMig">`, `/ig.fcgi` URL pattern, ImmoMig-specific data attributes.
  - Casasoft: HTML/JS references to `casasoft.ch` or `/api/PropertySearch` endpoint.
  - Schema.org: `application/ld+json` block with `@type: RealEstateListing`.
  - Iframe-portal: detect `<iframe>` from `homegate.ch` / `immoscout24.ch` → flag as `skip` (no own data).
  - Otherwise: `custom` (flagged for manual review).

- CLI additions:
  - `wabe agencies probe <url>` — HTTP fingerprint one site, print detected family + suggested registry row to stdout.
  - `wabe agencies probe-portal <portal> --top=N` — mine portal detail pages (Flatfox / Homegate) for agency attribution, fingerprint each, emit draft registry rows. Output is yaml to stdout; user curates and pastes into `agencies.yaml`.
  - `wabe agencies validate <file>` — Zod validate + dead-link probe (HEAD per entry).
  - `wabe agencies stats` — listings volume per agency from last N scans (helps prune dead / low-value entries).

### 6.3 Deferred to post-Phase-C plans (conditional)

- `plugins/source-immomig` — build only if discovery spike shows ≥15% share.
- `plugins/source-casasoft` — same threshold.
- LLM-based extractor for `custom`-bucket agencies (separate spec; cost-controlled, opt-in).
- Pre-built agency registry shipped with wabe (user maintains privately — that is the entire point of the pluggable design).

### 6.4 Config wiring

```yaml
# wabe.yaml
sources:
  - kind: agencies
    config:
      registry: ./agencies.yaml          # local file (recommended default)
      # OR
      registry: https://my-server/agencies.yaml
      registry_auth: ${env.WABE_REGISTRY_TOKEN}
      # OR
      registry: git+ssh://you@host/agencies.git#main
      refresh_interval: 24h
      signature_pubkey: ${env.WABE_REGISTRY_PUBKEY}   # optional Ed25519 verify
```

Empty / absent registry → no agency sources active (graceful no-op).

### 6.5 Phase C out of scope

- Inline JS hooks for `custom` agencies in YAML (security risk; not supported).
- Multi-platform agencies (assume a single `platform` per entry; multi-platform sites get classified `custom` and handled by schema.org fallback or skipped).
- Agency-side enrichment (broker phone scraping, viewing-slot calendars, etc.).
- Address-normalization for cross-source dedup (uses Phase A bucket dedup).

### 6.6 Phase C success criteria

- `wabe agencies validate ./agencies.yaml` passes on a hand-crafted 10-entry test registry.
- `wabe agencies probe https://walde.ch` (or similar) prints a valid suggested row.
- Registry of 3 schema.org agencies expands to 3 source instances and emits listings end-to-end.
- Distribution report from `wabe agencies probe-portal flatfox --top=500` committed to `docs/research/2026-05-18-agency-fingerprint-distribution.md` and informs the post-Phase-C decision on tier-2 family adapters.
- Agency-direct listings dedupe correctly against portal duplicates (Phase A pipeline), with the agency entry winning by priority and `seen_on_sources` correctly merged.

## 7. Cross-cutting concerns

See Phase A §4.2 for `Listing` schema additions and the dedup engine — these land in Phase A and are consumed unchanged by Phases B and C.

Additional cross-cutting items:

- **Per-source circuit breaker** (already on `main`) extends to agency entries — each agency is its own breaker state so one dead agency does not trip the family adapter for others.
- **Transport selection order** (Phase B): bridge → playwright → undici. `wabe doctor` reports which transport each source plugin will use given the current environment.
- **Bridge security** (Phase B): bind `127.0.0.1` only, never `0.0.0.0`. Shared secret stored in OS keychain. Pairing handshake required before any request is processed.
- **Config preprocessor pipeline** (Phase C): order is `load wabe.yaml → ${env.*} interpolation → agency registry expansion → final sources[] → Zod validation → plugin loader`. Pure transformation, fully testable.

## 8. Build order, dependencies, branch strategy

### 8.1 Phase ordering

1. **Phase A** — schema changes land once, benefits B and C; ships dedup before more sources multiply the duplicate problem.
2. **Phase C** — registry mechanism is novel and the user's private-asset angle; the discovery spike informs whether Phase B-sized investment in tier-2 family adapters is warranted.
3. **Phase B** — biggest refactor, most risk; the current Playwright path on `feat/source-homegate` already works for personal use, so Phase B is enhancement rather than blocker.

### 8.2 Dependencies (DAG)

```
Phase A:
  A1 Listing schema + migration (canonical_key, source_priority, seen_on_sources, first/last_seen_at)
  A2 Dedup engine + pipeline wiring                  ← A1
  A3 Notifier card "Also on:" footer                 ← A1
  A4 source-realadvisor                              ← A1
  A5 source-immoscout24-sitemap                      ← A1
  A6 source-immobilier-ch                            ← A1
  A7 Integration test (3 stub sources + overlap)     ← A2..A6

Phase C:
  C1 AgencyRegistry schema + JSON Schema export
  C2 Registry loader (file / HTTPS / git) + Ed25519 verify
  C3 Config preprocessor (expand registry → sources[]) ← C1, C2
  C4 agency-fingerprint package + heuristics
  C5 source-schemaorg generic adapter                 ← A1
  C6 CLI: wabe agencies probe / probe-portal / validate / stats ← C4
  C7 Discovery spike (run probe-portal flatfox --top=500 manually)
     → distribution report → decide on tier-2 adapters

Phase B:
  B1 @wabe/browser-bridge ws server + auth handshake
  B2 apps/extension-wabe (manifest v3, ws client, popup, pairing)
  B3 Transport abstraction in source-homegate (Undici/Playwright/Bridge) ← B1, B2
  B4 source-immoscout24 promotes sitemap → full-detail via bridge       ← A5, B1, B2
  B5 CLI: wabe bridge pair / status, doctor extensions
  B6 Integration test (extension ↔ bridge round-trip)
```

A4, A5, A6 are independent and can be built in parallel after A1 lands.

### 8.3 Branch strategy

- Phase A → new branch `feat/wave-1-sources` off `main`. **Not** the current `feat/source-homegate` branch — keep that branch parked for Phase B.
- Phase C → new branch `feat/agency-registry` off `main` after Phase A merges.
- Phase B → rebase / restart `feat/source-homegate` after Phase C merges. Transports added incrementally.

### 8.4 Commit discipline

- Each plan task = one atomic commit per project CLAUDE.md.
- Commit messages concise, no Claude/AI mention, signed (`git commit -S`) when possible.
- Each new plugin ships its own README per CLAUDE.md plugin convention.

## 9. Open issues to address in implementation plans (not in design)

- The current branch `feat/source-homegate` has four unstaged changes (`packages/core/src/engine/rental-term-lexicon.ts`, `packages/core/src/schemas/dsl.ts`, `packages/server/src/pipeline.ts`, `plugins/notifier-telegram/src/card.ts`). These must land on `feat/source-homegate` (or be cherry-picked) before Phase A starts on its own branch, otherwise they tangle the Phase B refactor.
- Tier-2 agency adapter selection in Phase C depends on the discovery-spike output — the implementation plan for Phase C should make this an explicit checkpoint, not a precommitment.
- Bridge auth handshake choice (Ed25519 vs HMAC vs noise protocol) is deferred to the Phase B implementation plan.

## 10. References

- Probe findings (all 2026-05-18):
  - `docs/research/2026-05-18-immoscout24-investigation.md`
  - `docs/research/2026-05-18-home-ch-investigation.md`
  - `docs/research/2026-05-18-alle-immobilien-investigation.md`
  - `docs/research/2026-05-18-comparis-investigation.md`
  - `docs/research/2026-05-18-immobilier-ch-investigation.md`
  - `docs/research/2026-05-18-realadvisor-investigation.md`
  - `docs/research/2026-05-18-engelvoelkers-investigation.md`
  - `docs/research/2026-05-18-housinganywhere-investigation.md`
  - `docs/research/2026-05-18-realestate-com-au-investigation.md`
- Prior Homegate investigation: `docs/research/2026-05-18-homegate-investigation.md`.
- Prior Homegate spec: `docs/superpowers/specs/2026-05-18-homegate-source-and-oauth-design.md`.
- Project conventions: `CLAUDE.md`.
