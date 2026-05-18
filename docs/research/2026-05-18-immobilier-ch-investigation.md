# immobilier.ch — programmatic access investigation

Date: 2026-05-18
Sample URL: `https://www.immobilier.ch/en/rent/apartment-house/zurich/zurich/page-1`

## 1. Public REST / JSON endpoints

No public JSON API. Probed:

- `/api/listings`, `/api/v1/listings`, `/v1/listings`, `/graphql` → all **404** (`server: Kestrel`).
- Hostnames `api.immobilier.ch` resolves (51.34.103.44) but `/`, `/listings`, `/v1/listings` all 404 from Kestrel — looks like internal/private surface.
- `app.immobilier.ch`, `m.immobilier.ch` → NXDOMAIN.
- Listing pages do **not** ship `__NEXT_DATA__`, `__INITIAL_STATE__`, GraphQL fetches, or any inline JSON payload of listings. There is a custom element `is="immo-page-object-search"` but no client-side data fetch.

Conclusion: the only programmatic surface is the **server-rendered HTML** plus its embedded JSON-LD.

## 2. Anti-bot stack

Effectively **none** at probe time:

- `server: Kestrel` (ASP.NET Core) behind **CloudFront** (`x-amz-cf-pop: ZRH52-P1`). Pure CDN passthrough — no challenge headers, no `cf-mitigated`, no `x-datadome`, no `x-akamai`, no JS challenge.
- Plain `curl -A 'Mozilla/5.0'` returns full 200 HTML on every probe (list, detail, filters, sitemap).
- No cookies required; no CSRF tokens; no Referer enforcement.
- Single mitigation: `Crawl-delay: 5` in `robots.txt`.

This is by far the friendliest Swiss portal probed so far (cf. Homegate's DataDome+Auth0, Comparis cookie wall).

## 3. Auth requirement

**Anonymous browsing fully sufficient.** Login is only needed for favorites, alert subscriptions, "e-Tenant" applications, and agent dashboards. Public list+detail pages, sitemaps, and JSON-LD are all unauthenticated.

## 4. Alternative surfaces

- **`/sitemap.xml`** → 200, lists three sub-sitemaps: `pages-sitemap`, `sales.xml`, `rents.xml`, plus `agences-sitemap`. The rents sitemap enumerates every `(canton, city)` rental search URL with `lastmod` (weekly `changefreq`) — useful for cheap change-detection.
- **JSON-LD on detail pages**: 5 blocks, including `@type: Product` (`Name` carrying rooms + price, `Offers.Price`, `priceCurrency: CHF`, image) and `@type: Residence` (`PostalAddress` with `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`). This is enough to populate every required Wabe `Listing` field.
- **JSON-LD on list pages**: only `Organization` + `BreadcrumbList` — listing entries themselves live in HTML cards (23/page, `data-id` attributes + canonical-pattern detail URLs ending in `-<id>`).
- **RSS / atom**: none — `/rss`, `/feed`, `<path>/rss`, `<path>.rss` all 404 or fall back to the HTML map page.
- **Mobile app API**: not externally reachable; the public `api.immobilier.ch` host 404s every guessed path.
- **Email alerts**: requires account.

## 5. Pagination + URL structure

Pure URL-encoded GETs, no POST search:

```
https://www.immobilier.ch/{en|fr|de}/{rent|sale}/{type}/{canton}/{city}/page-N[?nbp=N&pmax=X&...]
```

- `page-N` is straightforward; max page is rendered in the pagination block (extractable). 23 listings/page.
- Filters use short FR-style query params (`nbp` = rooms, `pmax` = price max, `gr=1` = grouped, `v=m` = map). Filter URLs return 200 with applied filter; the "X results" string near the title reflects the canton total (e.g. Geneva canton "993 appartements ou maisons").
- Tri-lingual URL slugs (`/en/rent/...`, `/fr/louer/...`, `/de/mieten/...`) — pick `/en/` for stable English slugs.

## 6. robots.txt + ToS

`robots.txt`:

```
User-agent: *
Sitemap: https://www.immobilier.ch/fr/sitemap
Crawl-delay: 5
```

No `Disallow`. All paths technically crawlable; 5 s pacing is the only requirement.

**ToS (`/en/terms-of-service`)** — Geneva-registered immobilier.ch SA — forbids "reproduction, distribution, or any other commercial use" of content without written authorization. A self-hosted personal AGPL agent that fetches pages a user would otherwise open in a browser, stores them locally, and never redistributes them is consistent with personal use; commercial republishing is not. Acceptable for Wabe's stated single-user use case; document this constraint and keep `Crawl-delay: 5` honored.

## 7. Coverage

**Romandie-focused.** Approximate `page-1` × `maxPage` × 23 estimates for `rent/apartment-house/<canton>/<city>`:

| Canton/City        | Pages | ~Listings |
| ------------------ | ----- | --------- |
| Geneva / Geneva    | 24    | ~550      |
| Vaud / Lausanne    | 22    | ~500      |
| Zurich / Zurich    | 10    | ~220      |
| Bern / Bern        | 2     | ~45       |

Canton-wide meta-description for Geneva quotes **993** — so the portal is materially complete in the French-speaking cantons but only ~30 % of Homegate's German-Switzerland volume in Zurich. Useful as a **secondary source for Romandie**, marginal for Zurich-only users.

## 8. Verdict — ranked candidate paths

1. **HTML scrape of list pages + JSON-LD on detail pages** (easiest). One GET per list page, one GET per detail page, parse JSON-LD with `@type: Product` and `@type: Residence`. No auth, no anti-bot, no JS rendering. Polite pacing at ≥5 s/request is already the documented requirement. Risk: HTML markup may change without notice — wrap selectors behind a thin extractor and lean on JSON-LD (semi-stable schema.org contract) for the structured fields. **Recommended.**
2. **Sitemap-driven incremental scan**: poll `sitemap/rents.xml`, compare `lastmod` per `(canton, city)` URL, only refresh changed slices. Pairs cleanly with option 1 to slash request volume.
3. **Hidden mobile API on `api.immobilier.ch`** (hardest, speculative). Host exists but every guessed path returns 404; would require capturing the official mobile app traffic. Not worth attempting in this slice.

### Recommendation for Wabe

Build `@wabe/source-immobilier-ch` along path **(1) + (2)**: an HTML scraper using `undici` (fixed `Crawl-delay: 5`), parsing list-page cards for IDs/URLs and JSON-LD on each detail page for price/rooms/address/coords. Far simpler than the Homegate plugin — no Playwright, no DataDome cookies, no Auth0. Position it primarily as a **Romandie source** (Geneva, Vaud, Fribourg, Neuchâtel, Valais, Jura) since Zurich coverage is weaker than Homegate's. Document the ToS personal-use constraint in the plugin README.
