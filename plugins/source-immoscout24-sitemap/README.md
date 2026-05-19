# @wabe/source-immoscout24-sitemap

URL-diff source plugin for [ImmoScout24.ch](https://www.immoscout24.ch). Watches the public sitemap (no anti-bot, no auth) and emits a new `Listing` each time a previously-unseen rental detail URL appears.

## Requirements

The plugin's **sitemap discovery** works without the bridge — URL-only emission
is fully functional standalone.

To emit full-detail listings (rooms, price, description, photos), set
`enrich_via_bridge: true` (the default) and run the Wabe browser bridge
(`wabe bridge pair` + load extension). Sibling CLI processes (`wabe scan
--source source-immoscout24-sitemap`) connect to the running daemon's bridge
via `${dataDir}/bridge.status.json`. Without any bridge available the plugin
logs a warning and continues with URL-only listings.

## Why URL-only

The HTML and API surfaces are DataDome + Cloudflare protected — see `docs/research/2026-05-18-immoscout24-investigation.md`. The sitemap is open and contains 38k+ rental URLs with `lastmod`, thumbnail image URL, and `<zip locality, canton>` geo. That is enough for a "new listing on IS24" Telegram notification with a tap-to-open button.

Detail fields (`rooms`, `area_m2`, `price`, `description`) are emitted as `null`. Phase B's browser bridge (separate spec) will promote this plugin to full-detail by re-fetching each PDP through a paired Chrome/Firefox extension.

## Config

```yaml
schedule: '*/15 * * * *'
root_url: 'https://www.immoscout24.ch/sitemap/sitemap.xml'
languages: ['de']        # restrict to German leaves; pick from de/fr/it/en
emit_on_first_scan: false  # safe default: first scan only seeds state
```

## State

Maintains a set of seen URLs in the `sitemap_state` table (key: `source-immoscout24-sitemap`). The first scan seeds this set silently (no notifications) unless `emit_on_first_scan: true` is set. Subsequent scans diff against the saved set and emit only previously-unseen URLs.

## Tests

`pnpm --filter @wabe/source-immoscout24-sitemap test`

XML parsing and mapping are tested with inline XML fixtures; no live network calls.
