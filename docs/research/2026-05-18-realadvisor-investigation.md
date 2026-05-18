---
date: 2026-05-18
status: research
topic: RealAdvisor.ch — public-search surface + anti-bot stack
---

# RealAdvisor.ch investigation (2026-05-18)

## Context

Sibling to the Flatfox / Homegate / ImmoScout24 / Comparis / Engel & Völkers
investigations. RealAdvisor is widely cited as a Swiss real-estate aggregator
backed by GraphQL. Question: can we add `@wabe/source-realadvisor` on a
Flatfox-tier easy path (anonymous REST, no captcha), or does it sit in the
DataDome bucket?

**Short answer: easiest path of any Swiss source we have probed so far.**
Anonymous, schema-validated, JSON REST endpoint at `https://realadvisor.ch/api/listings`.
No DataDome, no Cloudflare interactive challenge, no auth, no app-token, no
referer requirement. Default sort is `created_at desc` — ideal for a polling
agent.

## Probes executed (≈12 requests, no loops)

| # | URL                                                                                | Result |
|---|------------------------------------------------------------------------------------|--------|
| 1 | `HEAD https://realadvisor.ch/`                                                     | 302 -> `/en`, `server: cloudflare` (CDN only, no challenge) |
| 2 | `GET /robots.txt`                                                                  | 200, full multilingual allow-list + sitemap reference |
| 3 | `GET /sitemap.xml`                                                                 | 200, sitemapindex (content / agency / property-prices / search per locale) |
| 4 | `GET /en/rent/canton-zurich/house` (UA Chrome)                                     | 200, 1.1 MB HTML, `x-powered-by: Next.js`, `x-nextjs-prerender: 1` |
| 5 | grep HTML for `/api/`, `/graphql`                                                  | nothing literal — listings come inline in the RSC stream |
| 6 | `GET /graphql`                                                                     | 400 JSON `Must provide query string.` — server stack visible: `src/app.js`, `src/cors.js` |
| 7 | `POST /graphql` `{__schema{queryType{name}}}`                                      | 400 JSON — **introspection disabled** |
| 8 | `GET /api/listings`                                                                | 422 JSON Zod error revealing `offerType_eq ∈ {buy, rent}` |
| 9 | `GET /api/listings?offerType_eq=rent`                                              | 200 JSON, 36 listings, `total_count: 64688`, `similar_listings: [...]` |
| 10 | `GET /api/listings?offerType_eq=rent&compositePropertyType_eq=BANANA`              | 422 JSON revealing enum: `HOUSE_APPT, HOUSE, APPT, ROOM, PARK, PROP, BUILDING, COMMERCIAL, GASTRO, OTHER` |
| 11 | `GET /api/listings?offerType_eq=rent&compositePropertyType_eq=HOUSE&placeSlugs=[{"slug":"canton-zurich","lang":"en"}]` | 200, `total_count: 253` — matches the on-page aggregate (268 ± churn) |
| 12 | `GET /api/listings?offerType_eq=rent&page=2`                                       | 200, different first id — `page` is honoured (1-based), `offset`/`limit`/`cursor` silently ignored, page size fixed at 36 |
| 13 | `GET /api/listing/<id>`, `/api/listings/<id>`, `/api/search`, `/api/places`        | all 404 — `/api/listings` is the only documented surface; per-listing detail comes from RSC of the slug page |

## Public REST surface — `https://realadvisor.ch/api/listings`

- **Auth**: none. Plain `Accept: application/json`. No cookies, no app key, no referer.
- **CORS**: open (visible from the visible `src/cors.js` middleware allow).
- **Validation**: Zod on the server, errors echoed verbatim — saves us a discovery loop.
- **Sort**: defaults to `created_at desc`. Top of page 1 is literally the newest listing in Switzerland.
- **Pagination**: `page=N` (1-based), fixed 36 results / page. `total_count` is in every response, so we can iterate deterministically (e.g. 64 688 rentals ⇒ ≈1 800 pages — but for a search-filtered agent the slice is tiny: 253 pages of one for canton Zurich houses).
- **Filter params** (recovered from the RSC payload of the human page; same names accepted by the API):

  ```
  offerType_eq                 enum:  buy | rent
  compositePropertyType_eq     enum:  HOUSE | APPT | HOUSE_APPT | ROOM | PARK | PROP | BUILDING | COMMERCIAL | GASTRO | OTHER
  placeSlugs                   JSON-encoded array: [{ "slug": "canton-zurich", "lang": "en" }]
  salePrice_lte / _gte         number (CHF)
  salePricePerLivingSurface_lte / _gte
  salePricePerLandSurface_lte / _gte
  grossRentMonthly_lte / _gte  number (CHF)
  grossRentM2yearly_lte / _gte
  grossRentRoomMonthly_lte / _gte
  livingSurface_lte / _gte     m²
  landSurface_lte / _gte       m²
  id_eq                        for fetching a single listing
  ```

  `placeSlugs` must be sent as a JSON-string value (`--data-urlencode 'placeSlugs=[{"slug":"...","lang":"en"}]'`); the `placeSlugs[0][slug]=...` PHP-style array form is silently dropped.

- **Per-listing shape** is rich and Wabe-shaped:

  ```
  id (int), created_at, portal, title, translated_titles{de,en,fr,it},
  description (HTML), property_main_type, property_type, offer_type,
  currency, sale_price*, gross_rent_monthly, gross_rent_m2yearly,
  rent_net_monthly, rent_extra, construction_year, renovation_year,
  number_of_rooms, number_of_bathrooms, living_surface, usable_surface,
  land_surface, number_of_parking, address, postcode, locality,
  sub_locality, route, street_number, state, lat, lng,
  agency_id, agency_name, agency_logo_url, agency_portal_id,
  agency_contact_address, agency_contact_phone_number, agency_rating,
  agency_reviews_count, visit_contact_person, visit_contact_phone_number,
  images[] (with blurhash + file_name), bullet_points,
  clickout_url { hostname, url (opaque encrypted token) },
  show_contact_form, show_detail_page, show_phone_number, computed_surface
  ```

  Note the multilingual title prefill — RealAdvisor MT-translates titles into
  all four CH languages at ingest, so we can feed a localised card to Telegram
  with zero enrichment work.

## GraphQL endpoint

`POST /graphql` exists and is alive (`src/app.js:261` stack visible on the
error path) but **introspection is disabled**, so the schema is opaque. The
public site uses Next App Router server components that call `/api/listings`
under the hood — `/graphql` is presumably for first-party authenticated apps.
For Wabe we have no reason to touch GraphQL: the REST endpoint already exposes
the full search surface anonymously.

## Anti-bot stack

- **CDN**: Cloudflare (`server: cloudflare`, `cf-ray`, `cf-cache-status`, NEL
  reporting). No DataDome script, no hCaptcha, no Imperva, no managed
  challenge. `cf-cache-status: DYNAMIC` and `x-nextjs-cache: HIT` indicate
  ordinary edge caching.
- **No `__cf_bm` cookie** was set on the API responses we collected, and no
  bot-management JS challenge fired with a plain `Mozilla/5.0` UA.
- Risk: Cloudflare bot management can be flipped on per-route by the site at
  any time. Wabe should still go through our existing `undici` pacing +
  retry-with-backoff + per-source circuit-breaker, so a future hardening event
  degrades cleanly.

## Auth requirement

**Anonymous.** The site offers user accounts (saved searches, alerts) but the
search and listing data is wide open. No login wall, no metered free tier, no
"sign in to see address". Even the full street address (`Rebacher 3,
Grüningen, ZH, 8627`) and broker phone numbers come back in the anonymous
response.

## Aggregator semantics

This is the critical caveat for picking RealAdvisor over Flatfox / Homegate:

- Every listing observed in our sample carries `portal: "realadvisor"` and
  `clickout_url.hostname: "realadvisor.ch"`. The aggregator surfaces listings
  as if they all originate from RealAdvisor itself.
- The `clickout_url.url` field is an opaque AES-style token, not a plain URL —
  the actual outbound destination is resolved server-side at click time. So
  we cannot trivially see "this is really an ImmoScout24 / Homegate / Flatfox
  listing" from the JSON.
- `agency_portal_id` is the original portal slug at the broker level
  (`wolf-treuhand`, `srimmo`, …), not the source listing portal.
- For Wabe this means RealAdvisor is a *single broad source*, not a way to
  pierce other aggregators. If we already ship Flatfox + Homegate, **listings
  will overlap** — RealAdvisor's index is a superset that includes both.
  Dedup must be at the Wabe-listing level (we already have
  `agency_reference` + address + postcode + price + surface, which is enough
  for a fuzzy unique key).

## Alternative surfaces

- **Sitemap.xml** — fully populated, gzip-free, per-locale. Useful for
  enrichment / coverage audits but not for the freshness loop (search-result
  URLs only, no PDPs in the sitemap index entries we sampled).
- **JSON-LD** — only aggregate (Product / AggregateOffer / FAQPage /
  BreadcrumbList). No per-listing JSON-LD blocks. Not useful for ingest.
- **Embedded RSC payload** — listings are inlined in the `self.__next_f.push`
  RSC stream of every search URL, in identical shape to the `/api/listings`
  response. So scraping the HTML would also work as a fallback if the JSON
  endpoint is ever pulled — but there's no reason to do that today.
- **RSS / Atom** — none found in HTML head or robots.
- **Mobile app** — not investigated. Given that the desktop site itself eats
  `/api/listings`, it's almost certainly the same backend.
- **Email alerts** — saved-search feature exists for logged-in users; not a
  programmatic surface.

## robots.txt + ToS

- `robots.txt` `Disallow: /` is a default-deny, **then** opens explicit
  allow-lists for every locale prefix and content category (`/en/`, `/fr/`,
  `/de/`, `/it/`, plus `*.xml`, `*.css`, `*.js`, all image extensions,
  `/wp-content/*`, `/wp-includes/*`). Search-result URLs with query strings
  (`/en/rent/*?`) are explicitly disallowed for crawlers.
- The `/api/` namespace is **not mentioned at all** — neither allowed nor
  forbidden. By the standard "default-deny" reading of the leading `Disallow:
  /`, an XHR-style JSON API endpoint not enumerated in the allow-list is
  technically disallowed for crawlers.
- ToS were not fetched in this probe. Before shipping a source plugin we
  should read `https://realadvisor.ch/en/terms` and confirm there is no
  blanket prohibition on automated access. Wabe's stance (self-hosted,
  per-user agent, ≤1 polite poll per cron tick, no resale) typically lines up
  with portal ToS, but we should call this out explicitly in the plugin
  README.
- AGPL compatibility: yes — we'd be writing a pure-TS client against a public
  HTTP endpoint, no proprietary SDK, no licence taint.

## Verdict — ranked candidate paths

1. **REST `/api/listings`** — anonymous, schema-introspectable via 422
   errors, default-sorted by recency, paginated by `page`, no anti-bot
   challenge. Implementation cost ≈ Flatfox tier (a few hours).
   Risks: (a) Cloudflare hardening flip, (b) ToS clause we haven't read yet,
   (c) `/api/` not in robots allow-list.
2. **Embedded RSC scrape** — same data, available without ever calling
   `/api/`. Slower, more brittle (Next build IDs change), but resilient to a
   future API lockdown. Keep as documented fallback inside the same plugin.
3. **`/graphql`** — alive but introspection-disabled. Would require
   reverse-engineering the GraphQL query strings the Next server uses (the
   API key, if any, lives in the server bundle, not the client). Not worth
   it given path 1 works.
4. **Sitemap-only** — useful for batch coverage audits, useless for a polling
   freshness loop.

## Recommendation

Ship `@wabe/source-realadvisor` next, using `/api/listings`. It is the
**cheapest Swiss aggregator source we have found**, and the only one besides
Flatfox that needs zero browser, zero captcha, zero auth bootstrap. Expect
heavy overlap with Flatfox + Homegate — dedup at the Wabe-listing level (we
already have the fields needed). Plugin should:

- Use `undici` Pool with Wabe's standard pacing (≥1 s between calls per
  source).
- Send a plain modern desktop UA + `Accept: application/json` — no special
  headers.
- Filter at the server with `placeSlugs` (JSON-encoded), `offerType_eq`,
  `compositePropertyType_eq`, and the `*_lte / *_gte` range params.
- Page through with `page=1..N` until `(page-1)*36 ≥ total_count`.
- Map `id`, `gross_rent_monthly`, `living_surface`, `number_of_rooms`,
  `postcode`, `locality`, `lat`/`lng`, `agency_name`, `images[].file_name`
  into the Wabe `Listing` schema.
- Synthesize the public URL from the slug pattern visible in
  `clickout_url.hostname` + listing slug (the human-visible page is
  `https://realadvisor.ch/en/rent/<postcode>-<locality>/<id>`).
- Ship a `README.md` documenting the ToS-read step and the "RealAdvisor
  aggregates other portals — expect overlap with Flatfox / Homegate /
  ImmoScout24" caveat.
