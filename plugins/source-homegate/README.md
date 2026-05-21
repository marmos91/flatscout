# @wabe/source-homegate

## Requirements

`source-homegate` **requires the Wabe browser bridge**. DataDome (Homegate's
anti-bot stack) blocks any request that does not originate from a real Homegate
page context. Run `wabe bridge pair` once, load the extension, then start
`wabe start`. If no bridge is paired, plugin init fails fast with a clear error.

Sibling CLI processes (`wabe scan --source source-homegate`) connect to the
running daemon's bridge via `${dataDir}/bridge.status.json` and route requests
through the daemon's paired extension. Without a daemon running, the scan
fails fast.

## What it is

A Wabe **source** plugin that fetches Swiss rental listings from
[Homegate](https://www.homegate.ch) by replaying the iOS app's anonymous
search endpoint (`POST https://api.homegate.ch/search/listings`) against the
canonical header set captured in
[`docs/research/2026-05-18-homegate-investigation.md`](../../docs/research/2026-05-18-homegate-investigation.md).

The API is gated by **DataDome + Cloudflare** anti-bot. Every request is
dispatched through the Wabe browser bridge — a hidden tab loaded at the
genuine Homegate origin runs `fetch` from page context via
`chrome.scripting.executeScript({ world: 'MAIN' })`, so DataDome's hooked
`window.fetch` signs the request. No cookie harvesting, no Playwright
fallback — the bridge is the only supported transport.

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
```

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
| `fetch.backoff.on` | int[] | `[429, 500, 502, 503, 504]` | Status codes that trigger retry. |
| `fetch.backoff.retries` | int | `3` | Retry budget. |
| `fetch.backoff.base_ms` | int | `2000` | Base for exponential backoff (`base * 2^attempt`). |

> **403 handling.** Bridge transports cannot refresh DataDome state from
> Node — the cookie lives in the operator's real browser session. A 403
> from `api.homegate.ch` surfaces immediately as `HomegateAntiBotError`
> and trips the orchestrator's circuit breaker. The operator must reload
> Homegate in the paired browser to recover.

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

## OAuth bootstrap (optional, for user-account scoped endpoints)

Anonymous search works **without** logging in — the bridge handles the
DataDome challenge and no user token is required for `/search/listings`.

A separate **Auth0 PKCE flow** is provided for endpoints that bind to a
user account (favourites, saved searches, the future applicator). This
is unrelated to the anonymous search path:

- `wabe login homegate` — exchanges a PKCE authorization code (OOB
  copy-paste flow) for refresh and access tokens, persisted at
  `${dataDir}/secrets.json` with mode 0600.
- The plugin's `auth.ts` handles refresh-token rotation on next scan
  when the access token is close to expiry.
- `wabe logout homegate` — revokes the refresh token at Auth0
  (`/oauth/revoke`) and clears local credentials.

User-bound endpoints are not yet consumed by the v1 read-only search
path; the plumbing ships ahead of the next applicator spec.

## Known gaps (TODO)

- `available_from` is mapped to `null` — Homegate's `srp-list` fieldset
  doesn't carry it. A future capture of `pdp-full` will close the gap.
- `agency` is `null` — `listerBranding.logoUrl` alone is insufficient; the
  full lister object lives in a different fieldset.
- Non-zipcode geoTags (city / canton / radius search) are not supported in
  v1. Use `zipcodes:` only.

## Troubleshooting

- **`source-homegate requires the Wabe browser bridge`** — no in-process
  bridge (you're not running inside `wabe start`) and no daemon reachable
  via `${dataDir}/bridge.status.json`. Start `wabe start` with the
  extension paired, or run `wabe bridge pair` to set it up.
- **`HomegateAntiBotError` (403)** — DataDome rejected a request that
  was already routed through the bridge. The operator should reload
  Homegate in the paired browser to refresh the page-context session;
  the next scan should recover.
- **`homegate HTTP 429 …`** — slow down. Increase `fetch.pace_ms` and/or
  raise `fetch.max_pages` retry budget.
- **Listings missing photos** — Homegate occasionally returns localizations
  without `attachments`; the mapper falls back across `primary` → `de` →
  `en` → `fr` → `it`. If all are empty, photos will be `[]`.

## Attribution

- Endpoint: `https://api.homegate.ch/search/listings` (iOS Homegate app
  v15.62.0 contract, captured 2026-05-18).
- Reference investigation:
  [`docs/research/2026-05-18-homegate-investigation.md`](../../docs/research/2026-05-18-homegate-investigation.md).
- Inspired by the MIT-licensed
  [`denysvitali/homegate-rs`](https://github.com/denysvitali/homegate-rs)
  reference (now superseded by the captured Auth0 + DataDome contract).

## License

MIT, matching the rest of the Wabe project.
