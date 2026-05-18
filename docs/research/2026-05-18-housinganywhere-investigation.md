# housinganywhere.com investigation

**Date:** 2026-05-18
**Status:** Investigation only — not implemented
**Outcome:** HousingAnywhere is the **easiest non-Flatfox surface investigated to date**. The SSR HTML leaks an Algolia public search-only API key that returns the full unauthenticated `production_listings_rank_withOrpheus` index (~774 Zurich docs). No DataDome / Cloudflare / Akamai / hCaptcha. **But** their ToS explicitly forbids "screen scraping", "web spiders, crawlers, or similar tools for mass accessing", and "automated processes to collect information" — same posture as Homegate. Technical feasibility is high; legal alignment with the AGPL spirit of an end-user agent is the open question. Market fit for Zurich is also marginal: 90 % of inventory is short-term (`contractType: daily`), with only 87 monthly + 21 fortnightly contracts — relevant to newly-arriving expats, **not** to Wabe's primary long-term Swiss family use case.

## Probes run

- `curl -sI https://housinganywhere.com/` (no UA) → `HTTP/2 403`, `via: 1.1 google`, 134-byte body. Generic UA wall at the Google edge.
- `curl -sI -A '<Chrome 124>' https://housinganywhere.com/` → `HTTP/2 200`, sets only `ha_anonymous_id` cookie. **No CF / DataDome / Akamai / Imperva headers.** No `__cf_bm`, no `set-cookie: datadome`, no `cf-ray`.
- `curl -sI -A '<Chrome 124>' https://housinganywhere.com/s/Zurich--Switzerland` → `200`, 565 KB SSR HTML.
- `curl https://housinganywhere.com/robots.txt` → minimal. Only `/api/*`, `/my/*`, `/admin*`, and `/*/s/*?*` (parameterised search URLs) are disallowed. Plain `/s/Zurich--Switzerland` is allowed. No `Crawl-delay`. No `User-agent`-specific blocks.
- `curl https://housinganywhere.com/sitemap.xml` → 15 locale-scoped index sitemaps (en, de, fr, it, nl, es, pt, pl, ro, ru, sv, uk, zh + static + content). `sitemap-en.xml` has 10,592 URLs — **all category/SEO pages, zero listing-detail URLs** (no `/room/`, `/apartment/`, `/listing/`, `/p/` paths in the sitemap). Zurich has 12 SEO category pages (`/private-rooms`, `/apartment-for-rent`, `/long-term-rentals`, `/student-accommodation`, `/furnished-apartments`, …).
- Grep on Zurich SERP HTML for endpoints → custom React SSR (not Next.js — no `__NEXT_DATA__`). Globals exposed: `window.__PRELOADED_STATE__`, `window.__PRELOADED_CONFIG__`, `window.__CACHED_DATA__`, `window.__MOBILE_APP_CONTEXT__`. The state blob contains a literal `algolia` config:
  ```json
  "algolia": {
    "appId": "Y8L112MIBF",
    "apiKey": "170cf5d8f85035f219107d6fb900e3dd",
    "index": "production_listings_rank_withOrpheus",
    "indexNext": "production_listings_…"
  }
  ```
- Direct call: `POST https://y8l112mibf-dsn.algolia.net/1/indexes/production_listings_rank_withOrpheus/query` with the two headers above and `{"params":"query=Zurich&hitsPerPage=2"}` → **200 OK**, returns full hits with `_geoloc.{lat,lng}`, `city`, `country`, `contractType`, `currency`, full `description`, `apartmentBedroomCount`, `facility_total_size`, 50+ `facility_*` flags, `advertiserId/FirstName/Avatar/Rating`, `bookableDateFrom/To*`, `creationDateTS`, plus a media path under `housinganywhere.imgix.net`.
- `POST` with `facetFilters=[["city:Zürich"]]&facets=["city","country","contractType"]` → `nbHits: 738` total Zurich. Facet `contractType`: **666 daily, 87 monthly, 21 fortnightly**. Facet `country`: 774 Switzerland (the wider Zurich-region radius).
- ToS at `https://housinganywhere.com/terms` (the `/terms-and-conditions` URL returns a 404) → contains §5.x prohibited-use language: *"use of technologies such as web spiders, crawlers, or similar tools for mass accessing or saving Platform content, including screen scraping and other third-party services, is prohibited"*, *"using automated processes to collect information, are prohibited"*, *"Users are prohibited from circumventing the booking and payment processes"*.

## Findings

### 1. Public REST/JSON
**Algolia public search-only key, in the clear, in the SSR HTML.** This is the canonical hosted-search pattern: the `apiKey` is a search-only restricted key — it cannot write, cannot list indices, but it *can* freely paginate and filter the live listings index. App ID `Y8L112MIBF`, index `production_listings_rank_withOrpheus`. No auth, no Origin/Referer check, no `X-Algolia-User-Token` gating. The 1000-record/query and pagination limits are the standard Algolia defaults. Facet filters include `city`, `country`, `contractType`, plus presumably all `facility_*` fields. A working source plugin could be a thin Algolia POST wrapper.

The site's own `/api/*` is robots-disallowed; not needed because Algolia is the data plane.

### 2. Anti-bot stack
**None observed on the SSR HTML or on the Algolia plane.** No Cloudflare (no `cf-ray`, no `__cf_bm`), no DataDome (no `set-cookie: datadome`, no `x-datadome`), no Akamai (no `akamai*`), no hCaptcha/Turnstile, no Imperva. The only edge-layer behaviour is a UA gate at the Google CDN front (`via: 1.1 google`) that 403s a missing/empty UA. Any realistic UA bypasses it. The Algolia DSN is on Algolia's own CDN, completely separate from any anti-bot HousingAnywhere might add later to the HA-hosted SERP.

### 3. Auth
Search and listing browse are fully **anonymous**. Saved searches, messaging, and booking are login-walled (Google/Facebook/email SSO under `/my/*`). The Algolia key works without `ha_anonymous_id` or any other cookie.

### 4. Alternative surfaces
- **SSR JSON**: `window.__PRELOADED_STATE__` already contains the first page of search results when you GET `/s/Zurich--Switzerland`. Could be parsed as a zero-Algolia-dependency fallback path.
- **Sitemap**: only category landing pages, **no listing-detail URLs**. Not a discovery surface.
- **JSON-LD**: `application/ld+json` block present on SERP, but it's `BreadcrumbList` + `WebSite`; not per-listing `RealEstateListing`.
- **RSS**: none found.
- **Mobile-app API**: not probed; given the shared Algolia index, the app almost certainly calls the same index with a similar public key.

### 5. Coverage / market fit
HousingAnywhere is a **mid-term/expat platform**, not a Swiss long-term portal. The Zurich numbers prove it: **86 % daily, 11 % monthly, 3 % fortnightly contracts** — i.e. mostly furnished serviced/co-living/short-term sublet inventory, the opposite of the unfurnished 12-month family-flat segment Wabe targets (Flatfox + Homegate + ImmoScout24). The 87 "monthly" Zurich listings are the only ones plausibly comparable to Flatfox inventory, and even those will be furnished and priced in EUR with a HousingAnywhere booking-fee markup.

**Useful as**: a complementary source for the newly-arrived-expat subuse-case (first 3-12 months, furnished, ready to move in).
**Noise vs.** Flatfox/Homegate/ImmoScout24 for established long-term searches.

### 6. robots.txt + ToS
- `robots.txt` allows `/s/<city>--<country>` browse pages (the SEO surface), disallows `/api/*` and parameterised search URLs (`/*/s/*?*`). No UA-specific carve-outs.
- ToS §5.x explicitly forbids "web spiders, crawlers, or similar tools for mass accessing" and "screen scraping". Same legal posture as Homegate. A self-hosted per-user agent operated by the *user themselves* (Wabe's deployment model, low-volume polling) is in the same legal grey zone as it is for any other source plugin in the repo — but the language is no friendlier here than at Homegate.
- AGPL-compatibility for re-distributing code that calls Algolia: fine on the code side (we'd ship a thin client; no Algolia SDK dependency required).

### 7. Verdict — candidate paths, easiest → hardest

1. **Algolia direct (`@wabe/source-housinganywhere`, recommended technical path).** POST to `https://y8l112mibf-dsn.algolia.net/1/indexes/production_listings_rank_withOrpheus/query` with the SSR-leaked public key. Facet on `city:Zürich`, optionally `contractType:monthly`. Trivially polite-paceable via the existing `undici` Pool pattern. **Risks**: (a) ToS explicitly forbids automated collection — same risk class as Homegate, decision is policy not engineering; (b) public Algolia keys do rotate occasionally, so the plugin needs a "bootstrap from SSR HTML" fallback to re-discover `appId`/`apiKey` if a hardcoded value 401s; (c) the key may be IP-rate-limited at Algolia's edge (unverified — single-shot probes succeeded).
2. **SSR HTML parse of `window.__PRELOADED_STATE__`.** Slower (page-sized payloads, 565 KB per request), but no Algolia dependency and arguably the most defensible interpretation of "what a browser would do". Same ToS concern.
3. **Mobile-app API.** Unprobed. If it uses the same Algolia index with a different (also-public) key, same trade-offs. Not worth the reverse-engineering effort over option 1.
4. **Skip.** Defensible given (a) ~10 % of Zurich inventory matches Wabe's long-term thesis and (b) explicit ToS prohibition. The marginal user value is "first 3-12 months for newly-arrived expats", which is arguably a separate product.

## Recommendation

**Defer pending policy call, similar to Homegate.** If/when Wabe decides to ship sources that operate in ToS grey zones (Homegate already does, via a user-supplied CAPTCHA-solved cookie), HousingAnywhere becomes the *easiest second source to add by a wide margin*: ~150-line plugin, one Algolia POST per scan, no browser runtime, no captcha bootstrap, no DataDome. But scope it to `contractType:monthly` only, brand it clearly as the "newly-arrived / furnished mid-term" source, and surface it separately from the long-term portals in the UI/config so users opt in deliberately. Worth a one-line entry in `CLAUDE.md`'s "Deferred sources" alongside Homegate.
