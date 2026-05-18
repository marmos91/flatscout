---
date: 2026-05-18
status: findings
topic: Homegate API — captured contract (post-Auth0 migration)
supersedes: 2026-05-18-homegate-investigation.md
---

# Homegate capture findings (2026-05-18)

mitmproxy capture against iOS Homegate app v15.62.0 on iOS 26.4.2, with
the user logged in via Google SSO. All sensitive values redacted —
this doc records **structure**, not secrets.

## Endpoints

| Method | Host | Path | Purpose | Status |
|---|---|---|---|---|
| `GET`  | `auth.homegate.ch` | `/authorize` | Auth0 OAuth2 entry (PKCE, S256) | 302 |
| `POST` | `auth.homegate.ch` | `/u/login/identifier` | Auth0 universal-login step | 302 |
| `GET`  | `auth.homegate.ch` | `/login/callback` | Google SSO callback | 302 |
| `GET`  | `auth.homegate.ch` | `/authorize/resume` | Auth0 session resume | 302 |
| `POST` | `auth.homegate.ch` | `/oauth/token` | Code exchange → access/refresh tokens | 200 |
| `POST` | `api.homegate.ch`  | `/search/listings` | Listing search | 200 |
| `GET`  | `api.homegate.ch`  | `/listings/listings?ids=…&fieldset=srp-list` | Batch fetch by id | 304 (not modified — empty body in this capture) |
| `GET`  | `api.homegate.ch`  | `/favourites-api/favourites` | Saved listings | 200 |
| `GET`  | `api.homegate.ch`  | `/user-profile/profile` | Profile | 200 |
| `GET`  | `api.homegate.ch`  | `/points-of-interest-api/custom-points` | POIs | 200 |

## §3 Auth

PKCE-based authorization code flow.

**Initial `/authorize` query params**:

| Key | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | `lU7SBprOA383MV4TCsRfP9wUPc4JAcy1` |
| `scope` | `openid profile email offline_access` |
| `redirect_uri` | `homegate://login/redirect` |
| `audience` | `https://api.homegate.ch` |
| `code_challenge_method` | `S256` |
| `code_challenge` | 43 chars (base64url SHA-256 of verifier) |
| `ui_locales` | locale |
| `referral_url`, `referring_feature`, `referring_platform` | telemetry/UTM |

**Token exchange — `POST /oauth/token`** (Content-Type may be missing in iOS request — server tolerant):

```json
{
  "grant_type": "authorization_code",
  "client_id": "lU7SBprOA383MV4TCsRfP9wUPc4JAcy1",
  "code": "<45 chars>",
  "code_verifier": "<43 chars>",
  "redirect_uri": "homegate://login/redirect"
}
```

Response:

```json
{
  "access_token": "<JWT, ~1000 chars>",
  "id_token":     "<JWT, ~1260 chars>",
  "refresh_token": "<opaque, 90 chars>",
  "scope": "openid profile email offline_access",
  "expires_in": 1800,
  "token_type": "Bearer"
}
```

Refresh-token rotation confirmed in prior investigation. Same `client_id` / `audience` apply for the refresh grant.

## §4 Anti-bot stack

### Required headers (every `api.homegate.ch` request)

| Header | Value (per capture) | Notes |
|---|---|---|
| `Content-Type` | `application/json` (POST) | |
| `Accept` | `*/*` | |
| `Accept-Encoding` | `gzip, deflate, br` | |
| `Accept-Language` | `en-US,en;q=0.9` | matches device locale |
| `User-Agent` | `ch.homegate.Homegate/15.62.0 (iPhone, iOS 26.4.2, Scale 3.00)` | iOS device descriptor |
| `X-App-Version` | `Homegate/15.62.0/iPhone/iOS/23` | `/23` ≈ iOS major version code; differs from UA's `26.4.2` |
| `X-UDID` | `0E9A3DF1-F4D9-4AA5-9457-7246692CDE4D` | UUIDv4, persists across requests; per-install |
| `X-App-Id` | **26-digit decimal nonce** | unique per request (see below) |
| `Priority` | `u=3` | RFC 9218 priority hint |
| `Cookie` | datadome + cf_bm | session-bound (see below) |

**Authorization header is NOT sent on public search.** Bearer auth gates user-bound endpoints (favourites, profile, tenant-plus).

### X-App-Id

Across 11 requests in the capture:

```
41907962980229093277612248    POST  /search/listings
62732670267309748310420418    POST  /search/listings
66587954808390426938704568    POST  /search/listings
76795525636669216042807955    GET   /favourites-api/favourites
05225969303893365028407427    GET   /tenant-plus/authentication
9412888768387612599308236     GET   /user-profile/profile        ← only 25 digits
51082399791430554668182174    GET   /listings/listings
69752323059231733782108824    GET   /points-of-interest-api/custom-points
17355253092000002714256157    POST  /search/listings
67727098274361903790775635    POST  /search/listings
64253227549587254980540204    POST  /search/listings
```

Properties:
- 100% unique across requests
- Almost always 26 digits, occasionally 25 — i.e. **leading-zero stripping**; the underlying space is `[0, 10^26)`
- No correlation with timestamps (random ordering)
- No correlation with `X-UDID` (constant)
- No correlation with request body or path

Inference: **uniform random decimal nonce in `[0, 10^26)`**. Most likely
generated client-side as `secureRandom.bytes(?) → BigInt → toString(10)`,
or `Math.random()`-derived (less likely given iOS app crypto practices).
**Not HOTP-derived** as in the old homegate-rs.

Reproducible in TypeScript as:

```ts
function newXAppId(): string {
  // Uniform random in [0, 10**26)
  const buf = crypto.randomBytes(12);
  const n = (buf.readBigUInt64BE() << 32n) | BigInt(buf.readUInt32BE(8));
  return (n % 10n ** 26n).toString(10);
}
```

### DataDome + Cloudflare cookies

`Cookie` header on outbound requests is ~346 chars containing:
- `datadome=…` (DataDome session, rotated by `Set-Cookie` on most responses)
- `__cf_bm=…` (Cloudflare bot management)
- Plus Auth0/Google session bits inherited from the SSO flow

`x-datadome: protected` appears on every successful response.

Both cookies are **session-bound**, **bot-fingerprint-derived**, and
must be acquired through a DataDome challenge handshake — not
copyable from a captured session into a Node client without
re-triggering the challenge from the same IP/UA/TLS fingerprint.

### TLS / network identity

- CDN: CloudFront → Cloudflare → AWS API Gateway (per `via` and
  `x-amz-*` response headers).
- `cf-ray` and `cf-cache-status` confirm Cloudflare presence even
  though DataDome is the active gate.
- TLS pinning: **none observed** on this iOS app version. mitm CA
  trust is sufficient.

## §5 Endpoint contracts

### 5.1 Search — `POST /search/listings`

Request body (all observed variants combined):

```json
{
  "sortBy": "dateCreated",
  "sortDirection": "desc",
  "trackTotalHits": true,
  "from": 0,
  "size": 5,
  "fieldset": "srp-list",
  "query": {
    "offerType": "RENT",
    "propertyType": "APARTMENT_OR_HOUSE",
    "location": { "geoTags": ["geo-zipcode-8008", "geo-zipcode-8032", "geo-zipcode-8053"] },
    "monthlyRent":   { "to": 4500 },
    "numberOfRooms": { "from": 4.5 },
    "hasBalcony":  true,
    "hasElevator": true
  }
}
```

Observed:
- `sortBy`: only `dateCreated` (others unknown — likely `price`, `listingType`, `relevance`)
- `sortDirection`: `desc`
- `query.offerType`: `RENT` (likely also `BUY`)
- `query.propertyType`: `APARTMENT_OR_HOUSE` (others unknown — likely `APARTMENT`, `HOUSE`, `COMMERCIAL`, `PARKING`)
- `query.location.geoTags`: only `geo-zipcode-NNNN` observed; the iOS app also surfaces city/canton/radius pickers we did not exercise

Response top-level:

```json
{ "from": 0, "size": 5, "total": 5, "results": [...], "maxFrom": ... }
```

### 5.2 Listing result item

Each `results[i]` has:

```
id              string  — Homegate listing id
listingType     string  — "STANDARD" / others unknown
listing         object  — the listing payload (see below)
listingCard     object  — UI hints, e.g. {size: "M" | "S" | "L"}
listingScores   object  — {listingCompletenessScore, packageScore}
listerBranding  object  — {logoUrl, isQualityPartner, subscriptionType, isPremiumBranding, basePackage}
```

`listing` payload, observed keys:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `4003127729` style — 10-digit numeric, returned as string |
| `offerType` | string | `RENT` |
| `categories` | string[] | `["APARTMENT", "FLAT"]` — **does NOT carry furnished/temporary signal** |
| `platforms` | string[] | always includes `"homegate"` |
| `address` | object | see below |
| `prices` | object | see below |
| `characteristics` | object | see below |
| `localization` | object | per-language title/description/attachments |
| `meta` | object | `{createdAt: ISO}` |
| `valueAddedServices` | object | empty in observed listings |

**`listing.address`**:
```json
{
  "geoCoordinates": { "accuracy": "HIGH", "latitude": 47.3602325, "longitude": 8.584474 },
  "locality": "Zürich",
  "postalCode": "8053",
  "street": "Buchholzstrasse 13"
}
```

**`listing.prices`**:
```json
{
  "rent": { "interval": "MONTH", "area": "ALL", "net": 3714, "extra": 276, "gross": 3990 },
  "currency": "CHF"
}
```

**`listing.characteristics`** (sparse — only populated fields appear):
- `numberOfRooms` (number)
- `livingSpace` (number, m²)
- `floor` (int)
- `yearBuilt`, `yearLastRenovated` (int)
- `ceilingHeight` (number, m)
- `arePetsAllowed`, `hasCableTv`, `hasGarage`, `hasParking` (bool)
- `distanceHighSchool`, `distancePrimarySchool`, `distanceKindergarten`, `distancePublicTransport`, `distanceShop` (meters)

No `isFurnished` / `isTemporary` / `categories: ['FURNISHED']` observed.

**`listing.localization`**: `{de, en, it, fr, primary}`. `primary` is the source language (e.g. `"de"`). Each non-primary entry has `isMachineTranslated` set when auto-translated.

Per-language object:
```json
{
  "text":   { "title": "...", "description": "..." },
  "attachments": [
    {
      "type": "IMAGE",
      "file": "893384145d.jpg",
      "alt":  null,
      "url":  "https://media2.homegate.ch/listings/v2/nol/4003127729/image/9c04d2191ff23c8d684e5ccc7d57edf6.jpg"
    },
    ...
  ],
  "urls": [ { "type": "LINK", "title": "...", "value": "https://..." }, ... ],
  "isMachineTranslated": false
}
```

### 5.3 Rental-term detection — viability check

The capture caught both a **`befristet`** listing and a **`furnished … sublet`** listing in the same query. Neither has a structured flag — both rely entirely on the description text. Our existing `classifyRentalTerm` lexicon (DE/EN markers) catches both without modification. ✓

Snippets observed (verbatim):
- `"... befristet bis 31.01.2028 ..."`
- `"furnished 4.5-room apartment for sublet from jul/aug ... temporary sublet or temporary stay in zürich"`

### 5.4 Photo URLs

Pattern observed:

```
https://media{N}.homegate.ch/listings/v2/{prefix}/{listing_id}/image/{filename-hash}.jpg
```

Where:
- `media{N}` → at least `media2`; other CDN shards likely exist
- `{prefix}` → 3-char bucket (e.g. `nol`)
- `{listing_id}` → matches `listing.id`
- `{filename-hash}` → 32-char hex per image

Images appear under `listing.localization.{lang}.attachments[*].url` —
**already absolute URLs**, no signing query string. Choose the primary
localization's attachments to avoid duplicates across locales.

## §6 Mapper draft (for the future `@wabe/source-homegate` v2)

Field mapping from Homegate response → canonical `Listing`:

| `Listing` field | Source | Notes |
|---|---|---|
| `id` | `"homegate:" + listing.id` | |
| `source` | `"homegate"` | |
| `url` | `https://www.homegate.ch/rent/${listing.id}` | observed pattern; verify before plugin lands |
| `price.rent_net` | `listing.prices.rent.net` | |
| `price.extras` | `listing.prices.rent.extra` | |
| `price.total` | `listing.prices.rent.gross` | |
| `price.currency` | `listing.prices.currency` | |
| `price.deposit_months` | null | not exposed in search response |
| `rooms` | `listing.characteristics.numberOfRooms` | |
| `area_m2` | `listing.characteristics.livingSpace` | |
| `floor` | `listing.characteristics.floor` | |
| `total_floors` | null | not exposed |
| `built_year` | `listing.characteristics.yearBuilt` | |
| `renovated_year` | `listing.characteristics.yearLastRenovated` | |
| `location.coords` | `[address.geoCoordinates.latitude, .longitude]` | |
| `location.address` | `address.street` | |
| `location.postal_code` | `address.postalCode` | |
| `location.city` | `address.locality` | |
| `location.country` | `"CH"` (constant) | not in response |
| `location.region`, `.neighborhood` | null | not exposed |
| `description` | `localization[primary].text.description` | |
| `photos` | `localization[primary].attachments.filter(type=='IMAGE').map(url)` | |
| `available_from` | n/a | not in search response — may be in detail fieldset |
| `lease_until` | classifier output | description text |
| `rental_term` | classifier output | description text + (future) categories scan |
| `agency` | `listerBranding.…` | need to capture lister-name field — not in current capture |
| `features.*` | `characteristics.{hasGarage, hasParking, arePetsAllowed, hasCableTv, distance*}` | sparse bag |

## Known unknowns (not blocking but worth a follow-up capture)

1. **Pagination**: `from > 0`, `size > 5`. Response shape `{from, size, total, maxFrom}` is clear so we can iterate; just need to confirm `maxFrom` enforcement (likely a hard cap to discourage deep pagination).
2. **Non-zipcode geoTags**: `geo-city-...`, `geo-canton-...`, `geo-region-...` — the iOS app's city picker would emit these. Useful for broad searches without enumerating zip codes.
3. **Radius / map search**: did the iOS app emit `{lat, lon, radius_m}` instead of geoTags? Did not exercise.
4. **Detail batch fieldsets**: `srp-list` is the list-view subset. Other fieldsets (`pdp-full`, `pdp-card`, …) likely carry richer fields — e.g. `availableFrom`, full agency contact info.
5. **Agency / lister name**: not in `listerBranding.logoUrl` alone; the full lister object lives elsewhere in the schema. Detail-view fieldset likely carries it.
6. **DataDome challenge solving**: capturing the cookie set is one thing; **acquiring** it from a Node client requires either (a) embedding a stealth browser to pass the challenge, (b) integrating a third-party DataDome bypass service, or (c) running through a residential-proxy CAPTCHA-solver. The captured cookies in this session cannot be re-used from a different IP/UA/TLS fingerprint.

## Implementation paths (revised after capture)

The capture confirmed Option B is **harder than it looked**:

- The X-App-Id formula is a uniform random 26-digit decimal — trivial.
- DataDome challenge solving is the binding constraint, not request signing.

Realistic options:
- **A (stealth browser)** still cleanest. Now backed by a full mapper
  draft (this doc) so the plugin can be scaffolded immediately and
  fed by a Playwright-driven fetch shim.
- **B (full RE)** would require either solving DataDome's
  challenge dance in Node or proxying through a residential
  fingerprint-rotating service. Not worth it for personal use.

Recommendation: scaffold `@wabe/source-homegate` with the mapper from
§6, and ship two fetch backends behind a config flag:

1. `backend: api-direct` (the cheap fast path) — used only inside
   Switzerland / from a residential IP that has manually acquired
   a DataDome cookie via a one-time Safari handshake on the same mac.
   Cookie persisted on disk; refreshed by manual re-handshake when
   it ages out. Documented in the plugin README.
2. `backend: stealth-browser` (the resilient path) — Playwright +
   playwright-extra + stealth, scrape the same search-page JSON
   payload by intercepting the XHR. Slower, robust against
   DataDome rule changes.
