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

## Configuration drift

This source ingests **whatever the open browser tab shows** — the plugin reads
`window.__INITIAL_STATE__.resultList.search.fullSearch.result` from your
paired browser's currently-open ImmoScout24 search-results page. DataDome
refuses to serve `/rent?wzip=...` as a raw fetch (the JSON only exists as a
SPA-emitted XHR from a fully-hydrated tab), so the only viable transport is
"read whatever's on screen".

That means `search:` in your yaml is **informational only**. The plugin
compares it against the tab's live filter state (`searchModel`) and emits a
one-shot per-scan `warn` log when they diverge, but it cannot change what
the tab shows. To change filters:

1. Navigate inside the tab — adjust the SRP filters in the IS24 UI.
2. Let the SPA re-render with the new results.
3. The next Wabe scan will pick up the new listings.

If you depend on a specific filter set, keep the tab pinned to that URL.

## Tests

`pnpm --filter @wabe/source-immoscout24 test`

The captured SRP fixture under `test/fixtures/srp-zurich-page1.html` exercises
`parse.ts`, `map.ts`, and `enrich.ts` without live network access.
