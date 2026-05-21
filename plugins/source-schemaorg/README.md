# @flatscout/source-schemaorg

Generic source plugin for agency websites that emit `schema.org/RealEstateListing` (or `Apartment` / `House` / `Residence`) JSON-LD on their detail pages.

This is Flatscout's workhorse adapter for the Swiss agency long tail — many CMSes and bespoke sites embed structured data for SEO; this plugin parses it without needing per-agency code.

## When to use

The `@flatscout/agency-fingerprint` classifier returns `schemaorg` for a probed agency URL. Add the agency to your `agencies.yaml`:

```yaml
agencies:
  - id: walde
    name: Walde Immobilien
    website: https://walde.ch
    canton: ZH
    platform: schemaorg
```

The config preprocessor expands the row into a `source-schemaorg` plugin instance — no per-agency YAML needed.

## How it works

1. Fetches `<website><sitemap_path>` (default `/sitemap.xml`) or `feed_url` if set.
2. Sorts entries by `lastmod` desc, caps at `max_details_per_scan`.
3. For each detail URL: GET, extract first `application/ld+json` block whose `@type` is `RealEstateListing` / `Apartment` / `House` / `Residence`, map into Flatscout's `Listing`.
4. Honors `pace_ms` between requests.

## Tests

`pnpm --filter @flatscout/source-schemaorg test`
