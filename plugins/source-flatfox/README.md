# @wabe/source-flatfox

## What it is

A Wabe **source** plugin that fetches Swiss rental listings from
[Flatfox](https://flatfox.ch)'s public REST API
(`https://flatfox.ch/api/v1/public-listing/`) and emits canonical
`RawListing` records into the Wabe pipeline.

The API requires no authentication. The plugin uses an `undici` connection
pool with polite pacing, exponential backoff on 429/5xx, and honors the
orchestrator's `AbortSignal`.

## Install & enable

The plugin is part of the Wabe monorepo and ships as `@wabe/source-flatfox`.
Enable it in your `config.yaml`:

```yaml
sources:
  - name: source-flatfox
    enabled: true
    config:
      schedule: "*/2 * * * *"
      search:
        cities: ["Zürich", "Zurich"]
        price_max: 3000
        rooms_min: 2.5
        surface_min: 60
      fetch:
        page_size: 100
        max_pages: 5
        pace_ms: 2000
```

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `schedule` | cron | `*/2 * * * *` | Scan cadence. |
| `search.status` | string | `"act"` | Flatfox listing status filter. |
| `search.cities` | string[] | `[]` | Client-side filter: only emit listings whose `city` is in this list. Empty disables. |
| `search.price_max` | int | — | Max total rent (CHF). |
| `search.price_min` | int | — | Min total rent (CHF). |
| `search.rooms_min` | number | — | Min number of rooms. |
| `search.rooms_max` | number | — | Max number of rooms. |
| `search.surface_min` | int | — | Min living surface in m². |
| `search.offer_type` | string | `"RENT"` | Flatfox offer type. |
| `search.category` | string | `"APARTMENT"` | Flatfox `object_category`. Observed live enum: `APARTMENT`, `PARK`, `INDUSTRY`, `SECONDARY`, `SHARED` (the API catalog skews heavily toward parking spots, so this filter is essential). |
| `search.near.lat` | number | — | Latitude of the anchor for the radius filter (decimal degrees). |
| `search.near.lon` | number | — | Longitude of the anchor for the radius filter (decimal degrees). |
| `search.near.radius_m` | int | — | Radius in meters. Listings without coordinates (`latitude`/`longitude`) are excluded when `near` is set. |
| `fetch.page_size` | int | `100` | Page size sent to the API. |
| `fetch.max_pages` | int | `5` | Stop after this many pages per scan. |
| `fetch.pace_ms` | int | `2000` | Sleep between page requests, and between detail-page enrichment requests when `enrich_photos` is on. |
| `fetch.enrich_photos` | bool | `true` | Fetch each surviving listing's detail HTML to extract the cover photo URL (Open Graph `og:image`). Adds one HTTP request per surviving listing. Disable to halve outbound traffic at the cost of photo-less Telegram cards. |
| `fetch.backoff.on` | int[] | `[429, 500, 502, 503, 504]` | Status codes that trigger retry. |
| `fetch.backoff.retries` | int | `3` | Retry budget. |
| `fetch.backoff.base_ms` | int | `2000` | Base for exponential backoff (`base * 2^attempt`). |

> Note: Flatfox's server-side filtering is limited, so most filters are
> applied **client-side** after fetching. Tune `page_size` / `max_pages` to
> balance coverage against politeness.

### Rental term detection

The mapper populates the canonical `rental_term` and `lease_until` fields
on every listing using two signals:

1. **Structured**: `object_type === 'FURNISHED_FLAT'` → `rental_term: 'short'`
   (Blueground-style serviced apartments and other furnished sublets).
2. **Description regex**: a multilingual lexicon (DE/FR/IT/EN) detects
   markers like `befristet`, `möbliert`, `auf Zeit`, `meublé`, `temporaneo`,
   `furnished`, `short-term`, `sublet`, etc. Patterns matching
   `befristet bis DD.MM.YYYY` (and equivalents) also extract a concrete
   `lease_until` date.

Listings with no detected signal stay `rental_term: 'unknown'`. The
orchestrator's `rental_term.yaml` config controls how these classifications
are filtered (default `mode: long, exclude_unknown: false`). See
`examples/zurich-family/config/rental_term.yaml` for a reference policy.

## Credentials / auth

**None.** The Flatfox public listing API is unauthenticated. No env vars,
no secrets, no headers other than `accept: application/json`.

## Examples

Minimal config (all defaults):

```yaml
sources:
  - name: source-flatfox
    enabled: true
    config: {}
```

Zurich family of 2.5+ rooms under CHF 3'000:

```yaml
sources:
  - name: source-flatfox
    enabled: true
    config:
      search:
        cities: ["Zürich"]
        price_max: 3000
        rooms_min: 2.5
        surface_min: 60
```

Walking distance to a specific address (1 km radius around Zürich HB):

```yaml
sources:
  - name: source-flatfox
    enabled: true
    config:
      search:
        cities: ["Zürich"]
        price_max: 4500
        rooms_min: 3
        near:
          lat: 47.3782
          lon: 8.5404
          radius_m: 1000
```

Distance is computed client-side via the haversine formula; listings whose
API response omits coordinates are excluded.

Aggressive scan (one minute cadence, smaller pages, more retries):

```yaml
sources:
  - name: source-flatfox
    enabled: true
    config:
      schedule: "*/1 * * * *"
      fetch:
        page_size: 50
        max_pages: 10
        pace_ms: 1500
        backoff:
          retries: 5
          base_ms: 1000
```

## Troubleshooting

- **No listings emitted but the scan succeeds** — your client-side filters
  may be too tight. Drop `cities` / `surface_min` and re-scan.
- **`flatfox HTTP 429 …`** — you are being rate limited. Increase
  `fetch.pace_ms` and/or `fetch.backoff.retries`, or reduce
  `fetch.max_pages`.
- **`flatfox HTTP 5xx …`** — transient upstream issue. The plugin retries
  with exponential backoff; if it persists the per-source circuit breaker
  in the orchestrator will pause the source.
- **Coords missing for some listings** — Flatfox does not always publish
  `latitude` / `longitude`. The mapper sets `location.coords` to `null` in
  that case; distance-based scorers should tolerate `null`.
- **Wrong city case (`Zurich` vs `Zürich`)** — the client-side `cities`
  filter is a literal string match. Include both spellings if needed.

## Attribution

- Endpoint: `https://flatfox.ch/api/v1/public-listing/`
- OpenAPI schema: <https://flatfox.ch/api/v1/schema/>

A representative API response is captured in
`test/fixtures/responses/zurich-page-1.json` for reference and future
regression coverage. Live unit tests do not depend on this file; they use
inline fixtures and `undici` `MockAgent`.

## License

MIT, matching the rest of the Wabe project.
