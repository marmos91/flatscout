# home.ch investigation

**Date:** 2026-05-18
**Status:** Investigation only — not implemented
**Outcome:** home.ch is a thin WordPress storefront over Homegate's inventory and infrastructure (same legal entity, same API, same listing IDs). It offers **no independent programmatic surface**. The only added value over the existing `@wabe/source-homegate` would be a Cloudflare-only HTML-scrape path (no DataDome on `www.home.ch`), but at the cost of fragile HTML parsing and a ToS that explicitly forbids commercial republishing.

## Probes run

- `curl -sI https://www.home.ch/` → 200, `server: cloudflare`, `__cf_bm` set, `x-powered-by: PHP/8.2.31`, WordPress 6.7.5 links.
- `curl https://www.home.ch/robots.txt` → standard WP disallows; allows all reputable bots (including ChatGPT/Claude/Perplexity); 600s crawl-delay on a second `*` block.
- `curl https://www.home.ch/sitemap-en.xml` → directory sitemaps only (e.g. `/en/rent/apartment-and-house`); **no individual listing URLs**.
- `curl https://www.home.ch/en/rent/residential` → 200 HTML, 192 KB. Found inline: `window.appConfig.apiBaseUrl = 'https://api.homegate.ch'` and `window.appConfig.searchParameters = {"ver":2,"cli":"browser","cht":"rentall","sdi":"desc","nrs":20,"pag":1,"lang":"en","sor":"dateCreated","pub":"home"}`. Search frontend calls Homegate API directly with `pub=home`.
- `curl https://www.home.ch/en/wp-json/` → standard WP REST. Custom namespace `home/v1` with one route: `/home/v1/locations?name=&lang=` (autocomplete).
- `curl https://www.home.ch/en/wp-json/home/v1/locations?name=Zurich&lang=en` → `{"code":"unauthorized","message":"Unauthorized request origin","data":{"status":403}}` (Origin/Referer-gated, but trivially defeatable — see notes).
- `curl https://www.home.ch/api/search/rent` → `303 → /en/rent//` (no JSON endpoint; that path is a WP rewrite to the HTML listing page).
- `curl https://api.homegate.ch/search/listings?...&pub=home` with `Origin: https://www.home.ch` → `403`, headers `x-datadome: protected`, `x-dd-b: 2`, `set-cookie: datadome=…; Domain=.homegate.ch`. **Same DataDome stack as homegate.ch** — Origin doesn't matter.
- `curl https://www.home.ch/en/rent/apartment/at-zurich` → 200, 230 KB. **Listings are server-side rendered**: 40 `<a data-listing-id="…" data-listing-data="{...}">` per page with city, title, currency, address, price, thumbnail, zip, and a `homegate.ch/rent/{id}?utm_source=home` outbound URL. Pagination via `?pageNum=N`. Header reports `1380 results` for canton-Zürich rentals.
- `curl https://www.home.ch/en/rent/apartment/at-geneva` / `at-bern` → 200 in ~1 s, no rate-limit signals on a small burst.
- `curl https://www.home.ch/en/wp-json/wp/v2/types` → only standard WP types (post/page/media…). No listing CPT — listings are not in WordPress at all.
- RSS `https://www.home.ch/en/feed` → WP blog posts, **not listings**.
- ToS PDF `terms_conditions_en.pdf` → operated by Homegate AG; "users prohibited from making any further commercial use, particularly re-publishing or providing access on the internet"; "Any reproduction or distribution without prior written consent is prohibited."

## Findings

### 1. Public REST/JSON
**None of its own.** The site's only custom REST route is `home/v1/locations` (autocomplete, Origin-gated 403). Search is delegated to `api.homegate.ch` via browser-side fetches with `pub=home`. The string `/api/search/rent` on the search page is a WP rewrite that 303s to HTML, not a JSON endpoint.

### 2. Anti-bot stack
- `www.home.ch`: **Cloudflare only** (`__cf_bm` cookie, no JS challenge on plain curl). PHP/WordPress origin behind it.
- `api.homegate.ch` (the data plane): **DataDome + Cloudflare** — identical to the documented Homegate stack. `pub=home` and `Origin: https://www.home.ch` do not exempt it.

### 3. Auth
Search and listing-detail pages are **anonymous**. Saved-search/email-alert features (`/en/rent/.../myhome`) are login-walled and explicitly `Disallow`'d in robots.txt.

### 4. Alternative surfaces
- **Sitemaps**: directory pages only (no listing URLs).
- **RSS**: WP blog feed, no listings.
- **JSON-LD**: BreadcrumbList only — no `RealEstateListing` schema.
- **Embedded HTML JSON** (`data-listing-data` attributes): the most useful surface — every server-rendered listing card has a small JSON blob, but it lacks rooms, size, full description, coordinates of the building (lat/lng *are* there as separate `data-latitude`/`data-longitude`), so a follow-up GET on `homegate.ch/rent/{id}` is required for full fidelity → back to DataDome.
- **Mobile app**: not probed; given shared backend, almost certainly the same DataDome-gated API.

### 5. robots.txt + ToS
robots.txt allows public listing pages; `Crawl-delay: 600` on one `User-agent: *` block (effectively a request to be polite). ToS (last amended 2011) explicitly forbids commercial republication and any reproduction without written consent. AGPL distribution of a scraper that republishes Homegate inventory is the same legal posture as scraping homegate.ch directly.

### 6. Verdict — candidate paths

| Path | Effort | Risk |
|------|--------|------|
| **A. HTML scrape `www.home.ch/en/rent/...?pageNum=N`** | Low (Cloudflare-only, SSR JSON in `data-listing-data`). | Brittle to template churn; data is a subset (no rooms/size/description without a follow-up Homegate GET → DataDome). ToS-hostile. **No new inventory** — every listing links to `homegate.ch/rent/{id}`. |
| **B. Reuse `@wabe/source-homegate`** | Zero — already shipped with Playwright cookie bootstrap. | Same data set; no duplication. |
| **C. Call `api.homegate.ch` with `pub=home`** | Medium. | Same DataDome stack as Homegate. No benefit over (B). |
| **D. Skip home.ch entirely** | Zero. | None. |

## Recommendation

**Do not build `@wabe/source-home-ch`.** home.ch is operationally and legally Homegate: same company, same inventory, same listing IDs (`homegate.ch/rent/{id}` is the canonical detail URL), same anti-bot stack on the data plane. Any home.ch source would either (a) duplicate listings already harvested by `@wabe/source-homegate`, or (b) ship as a thin HTML scraper that yields a strict subset of fields and breaks on the next theme update.

If a future spec wants broader Swiss coverage, the next worthwhile targets are independent inventories — **ImmoScout24** (Scout24 group, separate stack), **Comparis** (aggregator with its own listings layer), or **newhome.ch** (cooperative-owned, distinct backend) — not Homegate-owned skins.
