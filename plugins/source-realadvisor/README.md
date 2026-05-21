# @flatscout/source-realadvisor

Source plugin for [realadvisor.ch](https://realadvisor.ch) — Swiss real-estate aggregator with a public REST endpoint.

## API surface

- Endpoint: `GET https://realadvisor.ch/api/listings`
- Anonymous: no API key, no auth, no captcha
- Pagination: 1-based, 36 items/page (`page=N`)
- Default sort: `created_at_desc` (newest first — perfect for polling)
- Response includes `total_count` for pagination planning

See `docs/research/2026-05-18-realadvisor-investigation.md` for the investigation notes.

## Aggregator caveat

RealAdvisor surfaces listings from other Swiss portals (Homegate, ImmoScout24, Flatfox, …) with an encrypted clickout URL token resolved server-side. The original portal is NOT exposed in the API. Heavy overlap with `@flatscout/source-flatfox` and `@flatscout/source-homegate` is expected; Flatscout's cross-source dedup (Phase A) handles the overlap and demotes realadvisor to a fallback when a portal duplicate is available (default priority `50` vs portals at `70-80`).

## Config

```yaml
schedule: '*/3 * * * *'
search:
  offer_type: rent
  composite_property_type: apartment
  place_slugs: ['canton-zurich']
  price_max: 4000
  surface_min: 80
fetch:
  max_pages: 5
  pace_ms: 2000
```

All `search.*` fields are optional with sensible Zurich-apartment-rental defaults.

## Tests

`pnpm --filter @flatscout/source-realadvisor test`

Tests use undici `MockAgent` with a captured fixture under `test/fixtures/responses/`. No live network calls.
