---
date: 2026-05-18
status: research
topic: Comparis (comparis.ch) — real-estate source feasibility
---

# Comparis investigation (2026-05-18)

## Context

Following the deferral of `@wabe/source-homegate` to its own Playwright + cookie
bootstrap path (see `2026-05-18-homegate-investigation.md`), we evaluated
`comparis.ch/immobilien` as a possible cheaper aggregator-style source for Wabe.
Comparis publicly markets itself as a meta-search across the major Swiss portals,
which on paper would let one source plugin substitute for several. This document
captures whether that surface is programmatically reachable today.

## 1. Public REST/JSON endpoints

No usable anonymous JSON surface was reached. Probes against every plausible
path returned `HTTP 403` with a DataDome challenge response:

- `GET /immobilien/` → `301 → /immobilien/default`, header `x-datadome: protected`
  on the redirect itself.
- `GET /immobilien/default`, `/immobilien/marktplatz/zurich/mieten`,
  `/immobilien/result`, `/immobilien/result/list`, `/immobilien/result/map`,
  `/immobilien/api/`, `/Comparis/api/V1/`, `/comparis/api/api`,
  `/immobilien/marktplatz/feed`, `/immobilien/marktplatz/rss` → all `HTTP 403`,
  body is the DataDome `ct.captcha-delivery.com` interstitial.
- Response headers consistently include `x-datadome: protected`,
  `x-datadome-cid: …`, `x-dd-b: 3`, and `accept-ch: Sec-CH-UA, …,
  Sec-CH-Device-Memory` (UA-CH fingerprinting hints), and a `datadome=…` cookie
  with `Max-Age=31536000`.

The fact that the very first cookie-less request fails means there is no
warm-up window: DataDome blocks before any XHR is observable to a curl client.
`robots.txt` (see §5) explicitly lists internal endpoints — `/immobilien/api/`,
`/immobilien/searchservice/`, `/immobilien/dataprovider/`,
`/immobilien/search/Count`, `/immobilien/search/GetPropertySubTypes`,
`/immobilien/result/favoritelist`, `/immobilien/marktplatz/result.aspx`,
`/immobilien/handlers/Image`, etc. — confirming these are server-rendered
ASP.NET XHR endpoints, not a documented public REST API. They are all behind
the same DataDome edge.

## 2. Anti-bot stack

**DataDome** (confirmed). The challenge served is the standard
`https://ct.captcha-delivery.com/c.js` script with a `dd` config object — the
same vendor and same flow as the Homegate public-search edge. No Cloudflare,
Akamai, Imperva, hCaptcha, or reCAPTCHA signals were observed. Client-hints
negotiation (`Sec-CH-UA-Full-Version-List`, `Sec-CH-Device-Memory`, etc.) is
part of the fingerprint surface, meaning a naïve `undici` client would not be
sufficient even if a DataDome cookie were stapled in.

## 3. Auth requirement

The catalog itself is anonymous in the browser — there is no login wall for
search results. Therefore the blocker is not auth; it is purely the DataDome
edge.

## 4. Alternative surfaces

- **RSS / Atom**: none found. `/immobilien/marktplatz/rss` and
  `/immobilien/marktplatz/feed` both 403.
- **sitemap.xml**: served by Comparis but the response is itself a DataDome
  challenge page on cookie-less requests, so we cannot parse it programmatically
  without solving the challenge.
- **JSON-LD on listing detail pages**: not verifiable without bypassing
  DataDome.
- **Mobile-app API**: not investigated by capture in this round; Comparis
  publishes apps (`comparis.ch`) on iOS/Android. Given the same vendor
  (DataDome) protects the public web edge and Comparis is in the same
  vendor cohort as Homegate, prior odds of finding an unprotected mobile API
  are low. Out of scope for this round.
- **Email alerts (`searchsubscription`)**: explicitly `Disallow`-ed in
  robots.txt (`*/searchsubscription/`), and would in any case require account
  creation and offer no structured payload back to us.

## 5. robots.txt + ToS

`robots.txt` (fetched OK over both `www.` and `en.` hosts) is permissive on
canonical SEO pages and **explicitly blocks every machine-friendly endpoint**:

```
Disallow: /immobilien/api/
Disallow: /immobilien/dataProvider/
Disallow: /immobilien/searchservice/
Disallow: /immobilien/SessionValueReader/
Disallow: /immobilien/search/Count
Disallow: /immobilien/search/GetPropertySubTypes
Disallow: /immobilien/result/favoritelist
Disallow: /immobilien/result/searchsubscriptionlist
Disallow: /immobilien/marktplatz/result.aspx
Disallow: /immobilien/details/
Disallow: /immobilien/image/get
```

`AhrefsBot` and other crawlers are blanket-denied. The site is operated by
Comparis Deutschsprachige Schweiz AG and the ToS (linked from the footer) is
the standard "no scraping, no derivative database" clause typical of Swiss
portals — i.e., even if we bypassed DataDome, redistribution of harvested
listings via an AGPL fork would not be a license-compatible posture.

## 6. Aggregator semantics

Comparis self-describes (and is broadly understood) as a meta-search over
Homegate, ImmoScout24, Flatfox, and Newhome, deduplicating across them and
showing source-portal attribution on the listing card. For Wabe specifically
this would have meant one plugin replacing four — attractive on paper.

However:

- We already have `@wabe/source-flatfox` (free, no anti-bot) covering the
  Flatfox slice directly, with richer raw fields than the aggregator card.
- We already have `@wabe/source-homegate` accepting a Playwright cookie
  bootstrap to talk to Homegate's own anti-bot edge — the very same DataDome
  vendor that fronts Comparis. Solving DataDome for Comparis is the same
  engineering problem we already solved for Homegate, but in service of a
  *less* authoritative payload (Comparis card vs. the original portal listing).
- Comparis deduplicates upstream, which means we would *lose* signal we
  currently keep: duplicate detection across portals is a Wabe-side concern
  (we want the original portal IDs and direct application URLs, not a
  Comparis-side merged record).
- The ToS clause (no derivative database) is stricter at the aggregator than
  at the source portals, because Comparis is itself reselling the aggregation.

## 7. Verdict

Ranked easiest → hardest:

1. **Do nothing — drop Comparis from scope.** Flatfox is covered by the
   existing zero-auth plugin; Homegate is covered by the existing cookie-
   bootstrap plugin; ImmoScout24 and Newhome are better tackled as their own
   direct-source plugins (their edges are independent and at least Newhome is
   historically gentler). Comparis adds engineering cost without adding any
   listing that isn't already reachable from a direct portal.
2. **Reuse the Homegate cookie-bootstrap pattern against Comparis.** Same
   DataDome vendor, same `wabe homegate-bootstrap`-style flow could be
   generalised. Cost: a second Playwright bootstrap UX and another fragile
   cookie; benefit: a denormalised aggregator payload we'd then have to
   re-decompose into per-portal IDs. Net negative versus option 1.
3. **MITM the Comparis mobile app** to find an unprotected RPC. Speculative,
   high time-cost, and even on success exposes us to the strictest ToS
   posture in our source set.
4. **Headless full-page scrape** of `/immobilien/marktplatz/<city>/mieten`
   HTML. Brittle SSR DOM, still requires DataDome, and a clear ToS violation.

**Recommendation: option 1.** Defer Comparis indefinitely; invest the next
unit of source-plugin effort in a *direct* `@wabe/source-immoscout24` or
`@wabe/source-newhome` plugin instead. Aggregator-as-source is the wrong
trade for Wabe: we want canonical portal IDs and direct application URLs,
not pre-merged cards, and we want the source plugin's risk surface to be the
portal's own anti-bot stack, not an aggregator's.
