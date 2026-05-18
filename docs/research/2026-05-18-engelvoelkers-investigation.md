# engelvoelkers.com (Engel & Völkers) investigation

**Date:** 2026-05-18
**Status:** Investigation only — not implemented
**Outcome:** Engel & Völkers exposes a fully public, anonymous JSON search API (`search-bff.engelvoelkers.com`) used by its own Next.js frontend. No DataDome, no Cloudflare challenge, no auth. Switzerland coverage is real but luxury-skewed (~7.7k rent listings country-wide, only **8 inside Zurich city placeId** with 18 wider-area). Worth a small, low-effort plugin as a complement — not a replacement — for Flatfox/Homegate.

## Probes run

- `curl -sI https://www.engelvoelkers.com/` → `HTTP/2 307 → /ch/en`, `server: cloudflare`, no challenge cookies (only a benign `ns-ai-search-enabled` cookie). No DataDome, hCaptcha, Akamai, or Imperva signals.
- `curl https://www.engelvoelkers.com/robots.txt` → `Disallow: */search/*`, `Disallow: */propertysearch?*`, `Disallow: */account/`. **Country-localized rent search paths (`/ch/en/properties/res/rent/...`) are NOT in the disallow list.** Sitemap index points to per-country sitemaps and a global `sitemap_search.xml`.
- `curl https://www.engelvoelkers.com/sitemap_search/ch_en_0.xml` → public XML listing every Swiss exposé URL of the form `/ch/en/exposes/<uuid>` with `lastmod`. `Access-Control-Allow-Origin: *`. Effectively a free changelog.
- `curl 'https://www.engelvoelkers.com/ch/en/properties/res/rent/real-estate/zurich' -A 'Mozilla/5.0'` → `HTTP 200`, 832 KB HTML. Contains `<script id="__NEXT_DATA__">` with the **complete** SSR payload: `props.pageProps.searchModule.initialSearchResults.listings[]` (8 items) and `widerAreaListings[]` (18 items), each item a rich object (`id`, `displayId` like `W-049QIQ`, `propertyType`, `area.livingSurface`, `basePrice.rentNet`/`rentUtilities` in CHF, `rooms`, `bathrooms`, `addressComponents` w/ Google `placeId`, `coordinate{lat,lng}`, `uploadCareImageIds[]`, `shopName`). Also `dehydratedState.queries[0].queryKey` reveals the exact React-Query call: `['listings', { filters, options }]`.
- JS chunk `https://autogen-buyer.engelvoelkers.com/_next/static/chunks/842-*.js` → string `https://search-bff.engelvoelkers.com/api/v1`; chunk `2924-*.js` → routes `/api/v2/listing/search`, `/api/v2/listing/{id}`, `/api/v2/listing/search/geopoints`, `/api/v2/public/geocode/forward`, `/api/v2/autosuggestion/suggest`, `/api/v4/searchalert/unauth/alert/` (saved-search/email-alert endpoint with explicit `unauth/` path), and `/api/v1/ai/text-to-filter` (LLM natural-language filter).
- `POST https://search-bff.engelvoelkers.com/api/v2/listing/search?language=en&currency=EUR&measurementSystem=metric&marketCountryCode=CH&page=1&pageSize=35` with body `{"propertyMarketingType":["rent"],"businessArea":["residential"],"placeIds":["ChIJa_ltU3EKkEcRfy571124_mM"],"sortingOptions":["PUBLISHED_AT_DESC"]}` → **HTTP 200, identical JSON to SSR payload** (`{listingsTotal:8, listings:[…], widerAreaListings:[…]}`). Anonymous, no API key, no captcha cookie required. Only `Content-Type: application/json` is needed.
- Same `POST` without `placeIds` (country-wide) → `listingsTotal: 7746` rent / residential listings across CH.
- `GET /api/v2/listing/<uuid>?language=en&currency=EUR&measurementSystem=metric&marketCountryCode=CH` → HTTP 200, full listing detail (description, flooring, equipment, agent contact, geocoords).
- `curl -I https://search-bff.engelvoelkers.com/` → `HTTP 401 WWW-Authenticate: Basic` on root, but every documented endpoint is anonymous. `Access-Control-Allow-Origin` reflects the request `Origin` (passed `https://example.com` and got a 200 + CORS allow for the API call) — usable from non-browser callers without spoofing.
- `https://search-bff.engelvoelkers.com/robots.txt` → `User-agent: * / Disallow: /` — **the API host itself asks not to be crawled.** The main site's robots.txt does not block `/properties/.../rent/...` URLs.

## Findings

### 1. Public REST/JSON
Yes, and unusually clean. The Next.js storefront calls `https://search-bff.engelvoelkers.com/api/v2/listing/search` (BFF = backend-for-frontend) with the search options as **query parameters** and the filter object as a **JSON body**. Same endpoint covers all 35+ E&V country verticals via `marketCountryCode`. Detail endpoint is `GET /api/v2/listing/<uuid>`. Saved-search / email alerts are exposed at `/api/v4/searchalert/unauth/alert/` (anonymous email-alert creation — note the literal `unauth/` segment in the route).

Bonus path: **`__NEXT_DATA__` is fully populated by SSR**, so a zero-dependency HTML-only scraper works without ever calling the API.

### 2. Anti-bot stack
Cloudflare in front of `www` (CDN/edge only — no managed-challenge cookie issued for normal `Mozilla/5.0` UA on listing pages). **No DataDome, no Akamai, no Imperva, no hCaptcha/reCAPTCHA on listing pages or the API.** A 401 Basic-Auth on the API host's root is just the BFF's default `/` handler, not a real auth wall — every actual route is open.

### 3. Auth requirement
**None.** Anonymous calls return full listing payloads including agent contact. `Origin` is reflected by CORS, so any origin works. Favoriting and saved-search-with-account use `/api/v1/user-account/*` (out of scope for Wabe — we only need read).

### 4. Alternative surfaces
- **Sitemap**: `https://www.engelvoelkers.com/sitemap_search/ch_<lang>_0.xml` lists every Swiss exposé URL with `lastmod`. Perfect for change detection without polling search.
- **JSON-LD**: each listing detail page emits `application/ld+json` with `RealEstateListing` schema.org markup.
- **`__NEXT_DATA__` SSR JSON**: full machine-readable payload on every search page — robust fallback if the API ever closes.
- **RSS**: none.
- **Mobile app**: shares the same BFF (no need to reverse it).
- **Email alerts**: `/api/v4/searchalert/unauth/alert/` (might be usable as a notify path, but Wabe already owns notification).

### 5. Coverage / market fit
E&V is unambiguously luxury-skewed. Country-wide CH rent residential = **7,746** listings (incl. wider-area + commercial spillover). Zurich-city placeId = **8 rent listings** with 18 wider-area. Geneva, Bern, Basel scope similar order of magnitude. Median rent observed in the Zurich sample: CHF 5,200/mo net + utilities. Compared to Flatfox/Homegate/Comparis (10,000+ Zurich-canton rentals on any given day), E&V is a **boutique long-tail source** — useful only for high-end searches and broker-managed/off-market-style inventory that the major aggregators don't carry. Worth a plugin: **yes, but as an opt-in tertiary source**, not a default.

### 6. robots.txt + ToS
- `www.engelvoelkers.com/robots.txt` blocks search-result URLs only by query-string patterns (`*/suche?*`, `*/propertysearch?*`, etc.) and `/account/`. The localized **rent-listing pages we'd actually scrape (`/ch/en/properties/res/rent/real-estate/<city>`) are NOT disallowed**, and the API host (`search-bff.engelvoelkers.com`) is a different host from the one robots.txt covers.
- However, `search-bff.engelvoelkers.com/robots.txt` itself is `Disallow: /`. A polite implementation should therefore: (a) prefer the SSR `__NEXT_DATA__` extract over direct API calls, and/or (b) document the API surface as a known-public BFF and rate-limit very aggressively (≤1 req/min, exponential backoff).
- ToS were not directly fetched (the `/terms-of-use` URL 404'd; legal lives under cookie/privacy links in the footer per `__NEXT_DATA__`). Like every Swiss portal, ToS forbid systematic republishing; for **personal, single-user, non-commercial** rental-agent use this is the same posture as Flatfox/Homegate/Comparis. AGPL-compatible — no proprietary deps involved.

### 7. Verdict — ranked candidate paths

| # | Path | Effort | Risk | Yield |
|---|---|---|---|---|
| 1 | **Sitemap-diff + SSR `__NEXT_DATA__` HTML scrape** — poll `sitemap_search/ch_<lang>_0.xml` daily for new/changed `lastmod`, fetch each `/ch/en/exposes/<uuid>` page, parse `__NEXT_DATA__`. Stays entirely on the public web host that doesn't disallow these URLs. | Low (~half-day) | Lowest — no API ToS grey zone, Cloudflare-only, robots-clean | Full listing payload |
| 2 | **Direct BFF call `POST /api/v2/listing/search`** with body filters + query options, one call per Swiss canton placeId (collected via `/api/v2/autosuggestion/suggest`). | Lowest (couple hours) | Medium — API host `robots.txt` disallows everything, despite the API being publicly used by the storefront. Mitigate with conservative pacing. | Full listing payload, same shape as #1 |
| 3 | Hybrid: sitemap for change detection, BFF detail call `/api/v2/listing/<uuid>` for the body. | Low | Low | Best — only one detail fetch per genuinely-new listing |
| 4 | **Public email-alert endpoint** (`/api/v4/searchalert/unauth/alert/`) as a webhook into Wabe's own notifier. | Low | High — depends on a transactional email roundtrip, fragile parsing | Listings via email (worse latency than #1–#3) |

**Recommendation:** Path 3 — `engelvoelkers` plugin reads `sitemap_search/ch_<lang>_0.xml` for changelog, calls `GET /api/v2/listing/<uuid>` for new IDs, falls back to SSR `__NEXT_DATA__` HTML if the API ever closes. Ship as a tertiary source behind a config opt-in, since coverage is luxury-tier and total Zurich-area volume is two orders of magnitude below the existing sources.

## References

- Sample API call:
  ```
  POST https://search-bff.engelvoelkers.com/api/v2/listing/search
       ?language=en&currency=EUR&measurementSystem=metric
       &marketCountryCode=CH&page=1&pageSize=35
  Content-Type: application/json
  {
    "propertyMarketingType": ["rent"],
    "businessArea":          ["residential"],
    "placeIds":              ["ChIJa_ltU3EKkEcRfy571124_mM"],
    "sortingOptions":        ["PUBLISHED_AT_DESC"]
  }
  ```
- Sample exposé URL: `https://www.engelvoelkers.com/ch/en/exposes/0bc053a9-314f-54b8-be40-7accc5971451`
- CH placeId (Zurich city): `ChIJa_ltU3EKkEcRfy571124_mM` (Google Places ID — same one Flatfox/Homegate use internally).
- BFF base: `https://search-bff.engelvoelkers.com`
- Sitemap base: `https://www.engelvoelkers.com/sitemap_search/ch_<en|de|fr|it>_0.xml`
