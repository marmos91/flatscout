# @flatscout/source-immobilier-ch

Source plugin for [immobilier.ch](https://www.immobilier.ch). HTML-scraping plugin built on the site's public sitemap + embedded JSON-LD blocks. No anti-bot, no auth.

## Coverage caveat

immobilier.ch is **Romandie-heavy** (probe-time counts: Geneva ~993, Lausanne ~500, Zurich ~220, Bern ~45). For Zurich-focused configs, use the `url_must_include` filter to drop the FR-CH long tail:

```yaml
url_must_include: ['/zurich/zurich/']
```

For FR-CH users, leave the filter empty to scan everything.

## How it works

1. Fetches `https://www.immobilier.ch/sitemap/rents.xml` listing every active rental detail URL with `<lastmod>`.
2. Sorts by `lastmod` desc and applies `url_must_include` filter.
3. Iterates up to `max_details_per_scan` URLs (default 50), fetches each detail page, extracts `@type: Product` + `@type: Residence` JSON-LD blocks and maps them into `Listing`.
4. Honors `pace_ms` between requests (default 5000ms, matches site's stated `Crawl-delay`).

## Config

```yaml
schedule: '*/15 * * * *'
sitemap_url: 'https://www.immobilier.ch/sitemap/rents.xml'
pace_ms: 5000
max_details_per_scan: 50
emit_on_first_scan: false
url_must_include: ['/zurich/zurich/']
```

## Tests

`pnpm --filter @flatscout/source-immobilier-ch test`

XML parsing, JSON-LD extraction, and mapping use inline fixtures. No live network calls.
