# alle-immobilien.ch investigation

**Date:** 2026-05-18
**Status:** Not viable as a Wabe source plugin. Recommend skipping.

## TL;DR

`www.alle-immobilien.ch` is an SEO/SEA affiliate teaser site operated within the **Swiss Marketplace Group** (SMG) ecosystem. Every "listing" on the site is a server-rendered HTML teaser whose detail link points directly to `homegate.ch/mieten/<id>` or `immoscout24.ch/mieten/<id>` with `utm_source=al-imm` referral tags. It does not host its own listings, does not expose a JSON API, has no mobile-app surface, and is not an independent aggregator. Wabe already plans/has a Homegate source; ImmoScout24 is a separate future target. Implementing a `source-alle-immobilien` plugin would only duplicate (a small, lossy subset of) the same upstream data.

## 1. Public REST/JSON endpoints

- **None custom.** The site is WordPress (PHP 8.2 + WPML + iThemes/Solid Security + Redirection). No `/api/`, no `/graphql`, no XHR fetching listings — all listing markup is server-rendered into the HTML response.
- `/wp-json/` root responds, but only exposes generic WordPress namespaces (`wp/v2`, `oembed/1.0`, `wpml/v1`, `ithemes-security/rpc`, `contact-form-7/v1`, `redirection/v1`, …). There is no custom post type for listings.
- `GET /wp-json/wp/v2/types` returns `401 itsec_rest_api_access_restricted` — iThemes Security blocks anonymous WP REST. Even if it didn't, there are no listing CPTs to query (the teasers aren't stored as WP posts; they appear to be injected at render time from an SMG feed).
- `?page=N` pagination returns HTTP 404 but still serves the same HTML body — pagination either doesn't work for unauth crawlers or is intentionally broken. There is no obvious cursor parameter.

## 2. Anti-bot stack

- **Cloudflare** (CDN + `__cf_bm` cookie + `cf-ray`). Plain `curl -A 'Mozilla/5.0'` succeeds on every page — no JS challenge, no Turnstile, no managed challenge observed.
- **No DataDome, no Akamai, no Imperva, no hCaptcha/reCAPTCHA** in HTML or response headers.
- HSTS preload. `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- iThemes/Solid Security restricts the WP REST API but does not gate page HTML.

## 3. Auth requirement

Anonymous browsing is fully OK. No login wall, no email gate, no paywall. Listing teasers are public.

## 4. Alternative surfaces

- **`robots.txt`** — explicitly `Allow: /` for `*` (and named exemptions for ChatGPT/Claude/Perplexity/Applebot/OAI bots). Disallows only `/wp-login.php` and `/wp-admin/`. **`Crawl-delay: 600`** (10 minutes) — restrictive but advisory.
- **Sitemaps** — `sitemap-{en,de,fr,it}.xml` indexes published. Underlying sitemap files are hosted on S3 via nginx (`x-sitemap-source: s3-via-nginx`) and currently return **HTTP 403** to a plain `curl` from the apex domain. Sitemaps are likely fetched by search bots only with proper Cloudflare cookies; they list category URLs, not individual listing detail URLs.
- **No RSS feed** exposed on category pages (no `<link rel="alternate" type="application/rss+xml">` found in the HTML inspected).
- **No JSON-LD** in the rental listing index page (no `application/ld+json` blocks).
- **No mobile app** — the only app links in the footer go to **homegate.ch's** iOS/Android apps (`itunes.apple.com/.../id326131004`, `play.google.com/.../ch.homegate.mobile`). alle-immobilien.ch ships no native app of its own.

## 5. robots.txt + ToS

- `robots.txt` is permissive (`Allow: /` with named AI-bot exemptions, `Crawl-delay: 600`).
- Footer links to `privacy.swissmarketplace.group/de/` — site is operated within **SMG** (Swiss Marketplace Group, owners of Homegate + ImmoScout24). Ombudsstelle link goes to `konsum.ch/de/ombudsstelle-immobilienplattformen/`.
- ToS not deeply audited, but the AGPL question is moot — there is no upstream client library to import. Scraping risk is the standard "respect robots + reasonable pacing" gray zone.

## 6. Aggregator semantics — **the load-bearing finding**

This site does **not** aggregate. It is an **SMG-internal SEO satellite / affiliate teaser site** driving traffic to SMG's two main portals:

- A representative rental listings page (`/de/mieten/wohnung`, ~220 KB HTML) contains 25-27 teasers. **Every detail-link** points to either `homegate.ch/mieten/<id>` or `immoscout24.ch/mieten/<id>`, all carrying `?utm_source=al-imm` referral tags. Distribution observed on one page: 19 ImmoScout24, 6 Homegate, 0 others.
- The **listing IDs themselves** (e.g. `4003169388`) are the SMG-internal ad IDs, reused across both Homegate and ImmoScout24 detail URLs — confirming a shared upstream feed.
- No iframed listings, no on-site detail pages. Clicking a teaser navigates the user off the site entirely.
- Categories present: rent/buy x apartment/house/storage/parking/office/industry, segmented by canton.

Useful content beyond Homegate + ImmoScout24: **none**. There are no Flatfox, newhome, home.ch, comparis or independent listings.

## 7. Verdict — ranked candidate paths

| # | Path | Effort | Risk | Value |
|---|---|---|---|---|
| 1 | **Skip alle-immobilien.ch entirely** — implement `source-immoscout24` against SMG's portals directly. | Medium-high (SMG ImmoScout24 likely shares Homegate's DataDome/Auth0 stack) | Same anti-bot risk as Homegate, but original-source data quality. | High — net-new portal. |
| 2 | Sitemap-driven crawl of alle-immobilien.ch category pages, parse HTML teasers, follow outbound IDs back to homegate/immoscout24. | Medium (HTML scraping is fragile; `Crawl-delay: 600` caps refresh rate at ~10 min). | Brittle HTML; teasers are descriptions, not structured data — no price, no rooms, no surface area in machine-readable form (would require text parsing). Duplicate of Homegate data we already harvest via the bootstrap-cookie plugin. | Low — strictly a lossy subset of the Homegate/ImmoScout24 set. |
| 3 | Wait for an official SMG partner feed. | Out of scope (paid B2B). | n/a | n/a |

**Recommendation:** Do not build `@wabe/source-alle-immobilien`. Document in the project that this domain has been investigated and dismissed as an SMG SEO satellite that duplicates Homegate + ImmoScout24 with lossier metadata. Treat **ImmoScout24** as the next genuinely-new source target (separate spec); it will share the same DataDome/Auth0 challenges already characterised in `2026-05-18-homegate-investigation.md`, so the Playwright + cookie-bootstrap pattern from `@wabe/source-homegate` is the obvious reuse path.
