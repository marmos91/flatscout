# @wabe/source-homegate

## What it is

A Wabe **source** plugin that fetches Swiss rental listings from
[Homegate](https://www.homegate.ch) by replaying the iOS app's anonymous
search endpoint (`POST https://api.homegate.ch/search/listings`) against the
canonical header set captured in
[`docs/research/2026-05-18-homegate-capture-findings.md`](../../docs/research/2026-05-18-homegate-capture-findings.md).

The API is gated by **DataDome + Cloudflare** anti-bot, so the plugin
piggybacks on [`@wabe/browser-runtime`](../../packages/browser-runtime)
to harvest a fresh DataDome cookie via a headless stealth Chromium on first
run (and again on 403). All subsequent search calls are cheap `undici` HTTP
requests using those cookies.

## Install & enable

The plugin is part of the Wabe monorepo and ships as `@wabe/source-homegate`.
Enable it in your `config.yaml`:

```yaml
sources:
  - name: source-homegate
    enabled: true
    config:
      schedule: "*/5 * * * *"
      search:
        zipcodes: [8008, 8032, 8053]
        price_max: 4500
        rooms_min: 3.5
        has_balcony: true
        has_elevator: true
      fetch:
        page_size: 20
        max_pages: 5
        pace_ms: 2500
        cookie_max_age_hours: 12
```

> **First run downloads ~300MB of Chromium via Playwright.** This is a
> one-time, lazy install triggered by the bootstrap call — subsequent runs
> reuse the same browser binary.

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `schedule` | cron | `*/5 * * * *` | Scan cadence. Defaults are conservative — Homegate's anti-bot stack does not tolerate hammering. |
| `search.zipcodes` | int[] | `[]` | Swiss postcodes. Each is sent as `geo-zipcode-NNNN`. Empty means Switzerland-wide. |
| `search.price_max` | int | — | Max monthly gross rent (CHF). Maps to `query.monthlyRent.to`. |
| `search.price_min` | int | — | Min monthly gross rent (CHF). Maps to `query.monthlyRent.from`. |
| `search.rooms_min` | number | — | Min number of rooms. Maps to `query.numberOfRooms.from`. |
| `search.rooms_max` | number | — | Max number of rooms. Maps to `query.numberOfRooms.to`. |
| `search.surface_min` | int | — | Min living surface (m²). Maps to `query.livingSpace.from`. |
| `search.property_type` | enum | `APARTMENT_OR_HOUSE` | One of `APARTMENT_OR_HOUSE`, `APARTMENT`, `HOUSE`. |
| `search.offer_type` | enum | `RENT` | Only `RENT` is supported. |
| `search.has_balcony` | bool | — | Filter for balcony. |
| `search.has_elevator` | bool | — | Filter for elevator. |
| `search.sort_by` | enum | `dateCreated` | One of `dateCreated`, `price`, `roomCount`, `livingSpace`. |
| `search.sort_direction` | enum | `desc` | `asc` or `desc`. |
| `fetch.page_size` | int | `20` | Page size (Homegate caps at 50). |
| `fetch.max_pages` | int | `5` | Stop after this many pages per scan. |
| `fetch.pace_ms` | int | `2500` | Sleep between page requests. |
| `fetch.cookie_max_age_hours` | number | `12` | Max age of cached DataDome cookies before forcing a fresh bootstrap. |
| `fetch.backoff.on` | int[] | `[429, 500, 502, 503, 504]` | Status codes that trigger retry. |
| `fetch.backoff.retries` | int | `3` | Retry budget. |
| `fetch.backoff.base_ms` | int | `2000` | Base for exponential backoff (`base * 2^attempt`). |

> **403 handling is separate.** A single 403 invalidates the cached cookies
> and triggers an immediate re-bootstrap; a second 403 in a row raises
> `HomegateAntiBotError` and trips the orchestrator's circuit breaker.

## Rental term detection

Homegate's search fieldset does **not** carry a structured
`isFurnished` / `isTemporary` flag. The mapper instead reuses the same
multilingual classifier (`classifyRentalTerm` in `@wabe/core`) as
`@wabe/source-flatfox`:

1. **Description regex**: DE/FR/IT/EN lexicon detects markers like
   `befristet`, `möbliert`, `auf Zeit`, `meublé`, `temporaneo`,
   `furnished`, `short-term`, `sublet`. Patterns matching
   `befristet bis DD.MM.YYYY` (and equivalents) extract a concrete
   `lease_until` date.
2. **Unknown** when no signal is found — the orchestrator's
   `rental_term.yaml` config decides whether to keep or drop those.

## How DataDome cookies are managed

- Cookies are **harvested once** via headless Chromium against
  `https://www.homegate.ch/rent` (driven by `@wabe/browser-runtime`).
- They are **cached** at `${dataDir}/homegate-cookies.json` (mode 0600).
  Default `dataDir` is `$WABE_DATA_DIR` / `$XDG_DATA_HOME/wabe` /
  `~/.local/share/wabe`.
- They are **auto-refreshed** when (a) the cached file is older than
  `cookie_max_age_hours`, or (b) the API returns 403 once. A second 403
  in a row raises `HomegateAntiBotError`.

The plugin also persists a per-install identity at
`${dataDir}/homegate-install.json` — a stable UUID used as the `X-UDID`
header — so requests from the same machine look like the same client across
runs (matching the iOS app's behaviour).

## Authentication (optional, Phase 3)

Anonymous search works **without** logging in. A future
`wabe login homegate` flow will exchange an Auth0 PKCE authorization code
for refresh + access tokens, persisted at `${dataDir}/secrets.json`, and
the plugin will attach `Authorization: Bearer <…>` automatically when the
secrets are present. The `auth.ts` module already implements the
refresh-token grant and rotation; only the login command is missing.

## Known gaps (TODO)

- `available_from` is mapped to `null` — Homegate's `srp-list` fieldset
  doesn't carry it. A future capture of `pdp-full` will close the gap.
- `agency` is `null` — `listerBranding.logoUrl` alone is insufficient; the
  full lister object lives in a different fieldset.
- Non-zipcode geoTags (city / canton / radius search) are not supported in
  v1. Use `zipcodes:` only.

## Troubleshooting

- **`homegate anti-bot block (403) persisted after re-bootstrap`** — your IP
  or browser fingerprint is being challenged hard. Delete
  `${dataDir}/homegate-cookies.json` and re-run; if it persists, your
  residential IP may be temporarily flagged.
- **`homegate HTTP 429 …`** — slow down. Increase `fetch.pace_ms` and/or
  raise `fetch.max_pages` retry budget.
- **First run hangs on bootstrap** — Playwright is downloading Chromium
  (~300MB). Watch `~/.cache/ms-playwright/`. Subsequent runs are fast.
- **Listings missing photos** — Homegate occasionally returns localizations
  without `attachments`; the mapper falls back across `primary` → `de` →
  `en` → `fr` → `it`. If all are empty, photos will be `[]`.

## Attribution

- Endpoint: `https://api.homegate.ch/search/listings` (iOS Homegate app
  v15.62.0 contract, captured 2026-05-18).
- Reference investigation:
  [`docs/research/2026-05-18-homegate-capture-findings.md`](../../docs/research/2026-05-18-homegate-capture-findings.md).
- Inspired by the MIT-licensed
  [`denysvitali/homegate-rs`](https://github.com/denysvitali/homegate-rs)
  reference (now superseded by the captured Auth0 + DataDome contract).

## License

AGPL-3.0-or-later, matching the rest of the Wabe project.
