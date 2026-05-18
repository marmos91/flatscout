---
date: 2026-05-18
status: research
topic: ImmoScout24.ch — public-search surface + anti-bot stack
---

# ImmoScout24.ch investigation (2026-05-18)

## Context

Companion to `2026-05-18-homegate-investigation.md`. We already ship
`@wabe/source-flatfox` (public REST, no auth) and a Playwright-bootstrapped
`@wabe/source-homegate`. Question: can ImmoScout24.ch be added as a third
source on a Flatfox-like easy path, or does it sit in the same
DataDome-protected bucket as Homegate?

Short answer: same bucket as Homegate. DataDome + Cloudflare on every
dynamic surface; only the static sitemap is reachable from a plain HTTP
client.

## Probes executed (10 requests, no loops)

| # | URL                                                                       | Result                                                |
|---|---------------------------------------------------------------------------|-------------------------------------------------------|
| 1 | `HEAD https://www.immoscout24.ch/`                                        | 301 -> /de, `server: cloudflare`, `__cf_bm` set, CloudFront via |
| 2 | `GET /robots.txt`                                                         | 200, see below                                        |
| 3 | `GET /sitemap.xml`                                                        | Empty 404-shell HTML (Vue SPA)                        |
| 4 | `GET /sitemap/sitemap.xml`                                                | 200, real sitemap index (gzipped child sitemaps)      |
| 5 | `GET /sitemap/pdp/pdp-0-sitemap-RENT-en.xml.gz`                           | 200, 38 766 lines of canonical rent PDP URLs + image URLs + geo tags |
| 6 | `GET /en/real-estate/rent/city-zurich` (bare UA)                          | 403, DataDome HTML                                    |
| 7 | `GET /en/real-estate/rent/city-zurich` (full Chrome UA + sec-ch headers)  | 403, DataDome HTML                                    |
| 8 | `GET /rent/4002256697` (canonical PDP)                                    | 403, DataDome HTML                                    |
| 9 | `WebFetch /rent/4002256697` (Anthropic fetch UA)                          | 403                                                   |
| 10 | `HEAD api.immoscout24.ch/`                                               | 403, `x-amz-bucket-region: eu-central-1` (S3+CloudFront) |
| 11 | Probes for `/api/`, `/rest/`, `/graphql`, `/search-listings?...`           | All 301 -> trailing-slash strip or 404; no JSON API surfaced on the marketing host |

## Anti-bot stack — confirmed DataDome + Cloudflare

The 403 body on every dynamic page is the canonical DataDome bootstrap:

```html
<html><head><title>immoscout24.ch</title>…
  <p id="cmsg">Please enable JS and disable any ad blocker</p>
  <script data-cfasync="false">var dd={'rt':'c','cid':'…','hsh':'…','t':'bv',
    'host':'geo.captcha-delivery.com','cookie':'…'}</script>
  <script src="https://ct.captcha-delivery.com/c.js"></script>
  …
  <script src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'>…</script>
  <script defer src="https://static.cloudflareinsights.com/beacon.min.js/…">…</script>
</html>
```

- **DataDome** (`captcha-delivery.com`, `dd={...}` blob, `datadome` cookie) —
  identical vendor and integration shape to Homegate. The binding constraint.
- **Cloudflare Bot Management** — `__cf_bm` cookie issued on every response;
  `cf-ray`, `cf-cache-status: DYNAMIC` headers; `/cdn-cgi/challenge-platform/`
  asset present.
- **AWS CloudFront** in front of Cloudflare (`x-amz-cf-pop`, `via: … CloudFront`).
- No Akamai / Imperva / hCaptcha indicators observed.

Anonymous browsing is intended for human users — the DataDome challenge is
fired on the first request, not behind a login. There is no public login wall
on the search itself.

## What IS reachable without a challenge

The `/sitemap/*` tree is served straight from S3 via CloudFront with no
DataDome injection. Useful surfaces:

- `https://www.immoscout24.ch/sitemap/sitemap.xml` — sitemap index pointing
  to gzipped child sitemaps grouped by `pdp` (property detail pages, split
  `BUY` / `RENT` × `de|en|fr|it`), `drilldown`, `entrypage`, `agency*`,
  `extensions`.
- `pdp-N-sitemap-RENT-en.xml.gz` etc. — full canonical URL list, e.g.
  `https://www.immoscout24.ch/rent/4002256697`, with `<lastmod>` per URL,
  `xhtml:link hreflang` translations, and (critically) `<image:image>` blocks
  containing image CDN URLs and `image:geo_location` such as `1204, Genève, GE, CH`.
- The image CDN itself is on `cdn.immoscout24.ch` (e.g.
  `https://cdn.immoscout24.ch/listings/v2/spgge/4002256697/image/…jpg`) — also
  CloudFront, also no DataDome injection on the asset path.

In other words: we can cheaply enumerate "which listing IDs exist right now,
when they were last modified, and roughly where" without solving a challenge.
We cannot read price / rooms / surface / description without solving one.

## robots.txt

```
User-agent: *
Disallow: /*private/login?
Disallow: /*?*demoCustomerId=
Disallow: /*?an=G          ← but see Allow overrides below
Disallow: /*?*view= /*?*txt= /*?*src= /*?*pln= /*?*sem=
Disallow: /cdn-cgi/
Disallow: /(en|de|fr|it)-srp-new/*

Allow: /en/real-estate/rent/*?an=G
Allow: /en/real-estate/buy/*?an=G
Allow: /de/immobilien/mieten/*?an=G          (+ de buy, fr, it equivalents)

User-agent: ChatGPT-User / OAI-SearchBot / Claude-SearchBot / Claude-User /
            Perplexity-User / PerplexityBot / Applebot
Allow: /

Sitemap: https://www.immoscout24.ch/sitemap/sitemap.xml
```

The site explicitly allows the localized search results pages
(`/<lang>/(real-estate|immobilien|...)/(rent|mieten|...)/<location>?an=G`) and
sitemap crawling. Crawling individual `/rent/<id>` PDPs is not Disallowed.
There is no `Crawl-delay`. No live ToS scrape was performed in this probe;
that should be re-checked before shipping a plugin, since SMG (Scout24 Schweiz
AG) generally prohibits automated scraping in their consumer ToS.

## Auth requirement

None for search / browse. The wall is the DataDome challenge, not Auth0 /
session. No mobile-app API mention was reachable from the marketing host
within this probe budget — the iOS / Android app probably hits a separate
api host with its own anti-bot config (analogous to `api.homegate.ch`), but
that would need a mitmproxy capture to confirm.

## Alternative surfaces evaluated

- **JSON-LD inline on PDP** — not retrievable without solving DataDome, so
  cannot be confirmed from a plain HTTP probe. (For Swiss real-estate Scout24
  sites it is typical; needs a JS-capable fetch to verify.)
- **RSS feeds** — none referenced in robots.txt or sitemap; none under common
  paths checked.
- **Email saved-search alerts** — a known product feature; a future "ingest
  Wabe-owned mailbox" pipeline could parse those, same idea floated for
  Homegate. Out of scope for a v1 source plugin.
- **GraphQL / `/api/*` / `/rest/*` on the marketing host** — none found; all
  301-strip-trailing-slash or 404, none ever serve JSON. `api.immoscout24.ch`
  resolves to a denied S3 bucket (eu-central-1), so any API surface there is
  IP-allowlist or signed-URL only.
- **Mobile app API** — not investigated under this probe budget. Likely
  exists on its own host with DataDome (mirror of Homegate). Would require an
  iOS / Android mitmproxy capture.

## Implementation paths — ranked easiest to hardest

Recommendation, not commitment.

- **Option A — Sitemap-only "new listing" notifier (cheap, lossy).**
  Periodically diff `pdp-*-sitemap-RENT-<lang>.xml.gz` against a local store,
  emit a Telegram card per new URL with only the URL + `<lastmod>` + image
  thumbnail + geo (zip + city + canton from `<image:geo_location>`). No price,
  rooms, surface, description — user opens the link to see. No DataDome
  interaction. Zero auth. Low maintenance. **This is the only path that does
  not put us in an arms race.** Would fit as a separate plugin kind (a
  "URL-only Source") or as a degraded mode of a full Source.

- **Option B — Reuse the homegate-bootstrap pattern.** Same Playwright +
  persistent-context + interactive-CAPTCHA cookie harvest we already shipped
  in `@wabe/browser-runtime` for Homegate; swap target host and selectors.
  After bootstrap, replay the search XHR (which we have not yet identified —
  needs DevTools capture against a real browser session, separate spec task)
  with the harvested `datadome` + `__cf_bm` cookies and matching JA3 / UA.
  Highest coverage; same ongoing maintenance burden as Homegate.

- **Option C — Stealth headless browser only (Playwright + stealth +
  residential proxy).** Heavier per-request, but works without an interactive
  bootstrap. Same fragility as Option B against DataDome rule updates, plus a
  proxy bill.

- **Option D — Paid bypass / Apify actor.** Conflicts with self-hosted /
  AGPL ethos. Not recommended.

- **Option E — Drop ImmoScout24.** Flatfox + a future email-ingestion source
  may already provide adequate Zurich-area coverage; the marginal coverage
  gain from ImmoScout24 has to be weighed against another DataDome-shaped
  maintenance surface.

## Recommendation for the next spec

If the user wants ImmoScout24 coverage *soon* and is willing to accept
URL-only cards: ship **Option A** as `@wabe/source-immoscout24-sitemap`. The
implementation is essentially a cron over a small static XML file — no
browser, no anti-bot, no JA3 / cookie game. It complements (not replaces) a
future full plugin.

If the user wants parity with Homegate (price + rooms + surface in the card):
**Option B**, but treat it as a sibling milestone to the Homegate plugin —
they will share `@wabe/browser-runtime` and will fail / heal together when
DataDome shifts.

## References

- `docs/research/2026-05-18-homegate-investigation.md` — same vendor stack
  (DataDome + Cloudflare), same recommended fallback pattern.
- `packages/browser-runtime/` — already provides the persistent-context +
  interactive-CAPTCHA harvest primitive Option B would reuse.
- Captured DataDome bootstrap HTML and PDP sitemap snippet are quoted inline
  above; no secrets to redact.
