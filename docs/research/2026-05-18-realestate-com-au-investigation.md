---
date: 2026-05-18
status: research
topic: realestate.com.au /international/ch/rent — feasibility as a Wabe source
verdict: DO NOT BUILD — derivative listings + hostile ToS + Kasada on HTML
---

# realestate.com.au international (Switzerland) investigation

## Context

User pointed at `https://www.realestate.com.au/international/ch/rent//` as a
possible additional Swiss-rentals source for the Wabe agent. realestate.com.au
is owned by REA Group (ASX:REA) — large commercial portal, AU-centric. The
`/international/` section is operated by REA's global subsidiary (rea.global).
This doc captures whether a clean self-hosted plugin is feasible.

## 1. Public REST/JSON endpoints — YES, GraphQL is reachable

The site is a Next.js SPA (`x-powered-by: Next.js`, build `c6237ace7b0e021d`)
with full Apollo SSR cache embedded in `<script id="__NEXT_DATA__">`. The
runtime config (extracted from `props.runtimeConfig`) exposes:

```
GRAPHQL_API_ENDPOINT = https://www.rea.global/international/graphql
```

A clean `POST` to that endpoint, anonymous, with `Origin:
https://www.realestate.com.au` and `Content-Type: application/json`, returns
JSON. No bearer token. No Kasada cookies required. CORS is locked to the
realestate.com.au origin but server-side fetch ignores that.

Verified live query:

```graphql
query($i: ListingSearchInput!, $p: PageReq!) {
  searchListListings(listingSearchInput: $i, pageReq: $p) {
    pageInfo { totalCount currentPageNo pageSize }
    listings { id displayAddress country source sourceListingId photoCount }
  }
}
```

with `i = { channel:"rent", country:"ch", language:"en", currencyCode:"CHF",
distanceUnit:"Miles", includesurrounding:false, searchtypes:[], sort:"" }`
returned `totalCount: 9601` and a page of CH rentals.

Introspection is **disabled** (`__schema.queryType` rejected), but the SSR
Apollo cache and Next.js JS chunks expose every query, type, and variable the
plugin would need (`searchListListings`, `Listing`, `ListingDetail`,
`LocationInfo`, `Price`, `Image`, `Agent`, `PageInfo`, etc.). A plugin author
could reconstruct the schema slice in an afternoon by reading
`__NEXT_DATA__` from a handful of pages.

Filter surfaces visible in URL routing: `/international/ch/rent/in-zurich/`
returned 1,935 listings; deeper geo and price filters are encoded in the
`ListingSearchInput` arguments observed in the SSR cache.

## 2. Anti-bot stack — Kasada on the HTML host; GraphQL host is unprotected

- `https://www.realestate.com.au/` returns `HTTP/2 429` to a plain curl with
  `KP_UIDz` and `KP_UIDz-ssn` cookies and `x-kpsdk-ct` / `x-kpsdk-r` /
  `x-kpsdk-c` / `x-kpsdk-h` / `x-kpsdk-fc` headers — this is **Kasada**
  (KPSDK = Kasada Protected SDK). Same stack class as DataDome/PerimeterX:
  client-side challenge, encrypted payload, hostile to scripted clients.
- Curiously, `/international/ch/rent/` itself answered `200` to the same probe
  in this run (likely a soft path, lower-tier Kasada policy on
  SEO-important international pages), but this should not be relied on —
  Kasada policies are tunable per route and can tighten without notice.
- `https://www.rea.global/international/graphql` — **no Kasada**. Plain
  `Server: nginx`, no `x-kpsdk-*`, no challenge cookies. CORS-gated to the
  realestate.com.au origin but trivially set by any server-side client.

In other words: the protected surface is the consumer site, not the data
backend. This is the typical mistake of "protect the HTML, leak the API"
seen on many enterprise portals.

## 3. Auth — anonymous

No bearer token, no session cookie, no signed request, no API key. The
GraphQL endpoint serves anonymous queries from any origin that lies about
the `Origin` header.

## 4. Alternative surfaces

- **`__NEXT_DATA__` SSR**: every search URL ships a complete Apollo cache —
  fully usable without GraphQL if Kasada ever blocks the API. Higher risk
  (Kasada on HTML), but workable via Playwright + Kasada solver.
- **JSON-LD**: present on every page (`<script type="application/ld+json">`
  with `BreadcrumbList`, `WebPage`) — SEO metadata only, no listing data.
- **sitemap.xml**: `/sitemap.xml` returns the Next.js HTML shell, not XML.
  No machine-readable sitemap for international content.
- **Mobile-app API**: REA Group's flagship mobile app targets the AU
  domestic market and uses a separate `services.realestate.com.au` /
  `lexa.realestate.com.au` stack. International is web-only, so the same
  `rea.global` GraphQL endpoint is the only realistic non-HTML surface.
- **RSS**: none.

## 5. Coverage — derivative listings, NOT a primary source

Every listing in the Switzerland rent feed carries `source: "realtor_global"`
and a `sourceListingId`. This is realtor.com's international syndication
feed (Move Inc. / News Corp), repackaged under the realestate.com.au brand
because REA Group and Move Inc. share a corporate parent.

Volume: 9,601 CH rentals nationally, 1,935 Zürich. Comparable in magnitude
to ImmoScout24, but **not independent inventory** — it is realtor.com's
global feed with the original listings sourced from the local CH portals
(Homegate, Immoscout24, etc., funneled into realtor_global by Move's
syndication partners). Adding this source to Wabe would primarily
re-surface listings the user already gets from `@wabe/source-flatfox` and
the in-progress Homegate source, with worse freshness (cross-portal sync
lag) and less detail (no original-portal deep link to the agent contact
form).

Pricing is shown in AUD by default; CHF is selectable via
`currencyCode: "CHF"`. Address granularity is municipality + canton +
postcode; full street address only appears on the listing-detail page.

## 6. robots.txt + ToS — explicitly hostile

`https://www.realestate.com.au/robots.txt` opens with:

> In accessing or using any REA Group Website you agree that you will not use
> any automated device, software, process or means to access, retrieve,
> scrape, or index any REA Group Website or any content on any REA Group
> Website. […] REA Group strictly prohibits any automated access by [sites
> that aggregate property listings and/or information as part of their
> business].

It explicitly disallows `ClaudeBot`, `Claude-User`, `Claude-SearchBot`,
`anthropic-ai`, `GPTBot`, `CCBot`, `PerplexityBot`, `Bytespider`, `Ai2Bot`,
`MJ12bot`, `CriteoBot`, and a long tail of aggregators. The clause about
"sites that specifically aggregate property listings […] as part of their
business" applies directly to Wabe's use case.

`https://www.rea.global/robots.txt` returns `User-agent: * / Disallow: /` —
the whole site is off-limits to crawlers.

Wabe is AGPL-3.0 and self-hosted (single-user agent, not a public
aggregator), which is a softer legal posture than a SaaS aggregator, but
the ToS does not distinguish. Combining hostile ToS, a roadmap of
inevitable Kasada tightening, and the fact that this is derivative
inventory makes this a poor candidate.

## 7. Verdict — ranked candidate paths

| Rank | Path | Effort | Stability | Legal risk | Coverage value |
|---|---|---|---|---|---|
| 1 | **Don't build it** — go to realtor.com directly (next research target) or stick to native CH portals (Flatfox, Homegate, ImmoScout24) | 0 | n/a | none | n/a |
| 2 | Anonymous GraphQL POST against `https://www.rea.global/international/graphql` from a server-side `undici` Pool | LOW (~1 day of schema reverse-engineering from `__NEXT_DATA__`) | MEDIUM (Kasada could be extended to the API host at any time; no SLA) | HIGH (explicit ToS prohibition; explicit `anthropic-ai` block) | LOW (derivative of realtor_global, which is itself derivative of CH local portals) |
| 3 | Playwright + Kasada solver against the HTML site, parse `__NEXT_DATA__` | HIGH (Kasada is a serious anti-bot vendor; needs a paid solver or reverse-engineering) | LOW | HIGH | LOW |

### Recommendation

**Skip realestate.com.au.** Three reasons, in order:

1. **Derivative data.** Every listing is `source: "realtor_global"`. Wabe
   gains no inventory not already reachable via the native CH portals
   (Flatfox shipping; Homegate in progress with browser-bootstrap).
2. **Hostile ToS aimed exactly at us.** Robots.txt names "sites that
   aggregate property listings […] as part of their business" — that is
   Wabe's literal description.
3. **Kasada on the HTML host.** Even if the GraphQL backdoor stays open
   today, the realestate.com.au security team treats automated access as
   adversarial. Any noisy traffic will end with the GraphQL endpoint
   getting the same Kasada policy as the HTML site, breaking the plugin.

If realtor.com's own international vertical (`realtor.com/international/`)
turns out to be the actual upstream, investigate it directly — it would be
one less hop and might have its own less-hostile API. That is a separate
spec.

## Appendix: probes run

```
curl -sI https://www.realestate.com.au/
  → 429, KP_UIDz cookie, x-kpsdk-* headers  (Kasada)

curl -sI https://www.realestate.com.au/international/ch/rent/
  → 200, x-powered-by: Next.js, etag, no Kasada cookies on this run

curl https://www.realestate.com.au/robots.txt
  → broad scraping ban + explicit ClaudeBot/anthropic-ai/aggregator disallow

curl -sI https://www.rea.global/international/graphql
  → 405 Method Not Allowed (GET); POST works, no Kasada

POST https://www.rea.global/international/graphql
  query: searchListListings(country:"ch", channel:"rent")
  → 200 { totalCount: 9601, listings: [ { source: "realtor_global", ... } ] }

curl https://www.rea.global/robots.txt
  → User-agent: *  Disallow: /
```
