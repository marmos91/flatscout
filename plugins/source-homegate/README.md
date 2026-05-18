# @wabe/source-homegate

## What it is

A Wabe **source** plugin that fetches Swiss rental listings from Homegate's
private mobile JSON API (`https://api.homegate.ch/search/listings`) and
emits canonical `RawListing` records into the Wabe pipeline.

Unlike `@wabe/source-flatfox`, this endpoint is **not** a public web API.
It is the backend used by the official Homegate Android app, and it
requires both HTTP Basic Auth and a time-bucketed `X-App-Id` header
derived from HMAC-SHA256. The plugin ports the authentication algorithm
verbatim from the prior-art reference implementation
[`denysvitali/homegate-rs`](https://github.com/denysvitali/homegate-rs)
(MIT licensed).

> Important: this plugin uses an **unofficial** API. Your IP or the
> embedded credentials may be revoked at any time. Use only for personal
> use, respect Homegate's terms of service, and **do not republish the
> data**. See the "Legal posture" section below.

## Install & enable

The plugin is part of the Wabe monorepo and ships as `@wabe/source-homegate`.
Enable it in your `config.yaml`:

```yaml
sources:
  - name: source-homegate
    enabled: true
    config:
      schedule: "*/2 * * * *"
      search:
        location: { lat: 47.36667, lon: 8.55, radius_m: 1500 }
        monthly_rent: { from: 1000, to: 4000 }
        number_of_rooms: { from: 2.5 }
        living_space: { from: 60 }
        categories: ["APARTMENT", "ATTIC_FLAT", "MAISONETTE"]
      fetch:
        page_size: 50
        max_pages: 3
        pace_ms: 5000
```

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `schedule` | cron | `*/2 * * * *` | Scan cadence. |
| `auth.basic_user` | string | `hg_android` | HTTP Basic Auth username. |
| `auth.basic_pass` | string | `6VcGU6ceCFTk8dFm` | HTTP Basic Auth password. |
| `auth.app_secret` | string | `ABuTZrcTGKN4AwjHed3Hj` | HMAC-SHA256 key for `X-App-Id`. |
| `auth.app_version` | string | `Homegate/12.6.0/12060003/Android/30` | `X-App-Version` header AND part of the HMAC payload. |
| `auth.user_agent` | string | `homegate.ch App Android` | `User-Agent` header AND part of the HMAC payload. |
| `search.location.lat` | number | — | Center latitude of the search circle. |
| `search.location.lon` | number | — | Center longitude. |
| `search.location.radius_m` | int | `1500` | Search radius in metres. |
| `search.monthly_rent.from` | int | — | Min monthly rent (CHF). |
| `search.monthly_rent.to` | int | — | Max monthly rent (CHF). |
| `search.number_of_rooms.from` | number | — | Min rooms. |
| `search.number_of_rooms.to` | number | — | Max rooms. |
| `search.living_space.from` | int | — | Min living surface (m²). |
| `search.living_space.to` | int / null | — | Max living surface (m²). |
| `search.categories` | string[] | `["APARTMENT"]` | Homegate property category codes. |
| `search.offer_type` | string | `RENT` | Offer type filter. |
| `fetch.page_size` | int | `50` | Page size sent to the API. |
| `fetch.max_pages` | int | `3` | Stop after this many pages per scan. |
| `fetch.pace_ms` | int | `5000` | Sleep between page requests. |
| `fetch.backoff.on` | int[] | `[429, 500, 502, 503, 504]` | Status codes that trigger retry. |
| `fetch.backoff.retries` | int | `3` | Retry budget. |
| `fetch.backoff.base_ms` | int | `2000` | Base for exponential backoff (`base * 2^attempt`). |

> All `auth.*` defaults are public values extracted from the official Android
> APK and republished by `denysvitali/homegate-rs`. They are baked into the
> plugin so most users never need to override them. If Homegate revokes
> them, follow the mitmproxy capture procedure below.

## Credentials / auth

The plugin attaches the following headers to every POST:

| Header | Value |
| --- | --- |
| `Authorization` | `Basic base64(basic_user:basic_pass)` |
| `X-App-Id` | HOTP-style truncation of HMAC-SHA256 (see algorithm below) |
| `X-App-Version` | `auth.app_version` |
| `User-Agent` | `auth.user_agent` |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |

### `X-App-Id` algorithm

Ported verbatim from
[`homegate-rs/src/api/app_id.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/app_id.rs)
(MIT). The header is **not** a raw HMAC hex digest — it is a HOTP-style
dynamic-truncation of HMAC-SHA256, output as a signed decimal integer:

```
minute  = ceil(epoch_seconds / 60)
payload = USER_AGENT + APP_VERSION + minute        (concatenation, no separators)
mac     = HMAC-SHA256(SECRET, payload)             (32 bytes)
offset  = mac[31] & 0x0F                           (HOTP-style dynamic offset, 0..=15)
buf     = mac[offset..offset+4]                    (4 bytes)
buf[0] &= 0xFF                                     (no-op; preserved from the reference)
n       = read_i32_be(buf)                         (SIGNED 32-bit; may be negative)
X-App-Id = format!("{}", n)                        (decimal, e.g. "-1180187153")
```

The TS port lives in
[`src/auth.ts`](./src/auth.ts) and is exercised by a known-good vector in
[`test/auth.test.ts`](./test/auth.test.ts) (validated against the Rust
runtime; note the reference unit-test assertion `"1926888397"` is stale —
the live Rust implementation produces `"-1180187153"` for the same input,
which is what the TS port also produces).

## Response → canonical `Listing` mapping

| Homegate field | Canonical `RawListing` field |
| --- | --- |
| `result.listing.id` | `id` (prefixed: `homegate:<id>`) |
| — | `source = "homegate"` |
| `result.listing.link` *(if present)* else `https://www.homegate.ch/rent/<id>` | `url` |
| `result.listing.prices.rent.net` | `price.rent_net` |
| `result.listing.prices.rent.extras` | `price.extras` |
| `result.listing.prices.rent.gross` | `price.total` |
| *(constant)* `"CHF"` | `price.currency` |
| `result.listing.characteristics.number_of_rooms` | `rooms` |
| `result.listing.characteristics.living_space` | `area_m2` |
| `result.listing.characteristics.floor` | `floor` |
| `result.listing.coordinates.{latitude,longitude}` | `location.coords` (as `[lat, lon]`) |
| `result.listing.address.street` | `location.address` |
| `result.listing.address.postal_code` | `location.postal_code` |
| `result.listing.address.locality` | `location.city` |
| *(constant)* `"CH"` | `location.country` |
| `result.listing.description` | `description` |
| `result.listing.images[].url` (or string) | `photos` |
| `result.listing.realtor.name` | `agency` |

Fields not present in the response (`total_floors`, `built_year`,
`renovated_year`, `available_from`, `region`, `neighborhood`) are set to
`null`. The four "extension" maps (`features`, `contact`, `enriched`,
`extra`) are initialised to `{}`.

## Examples

Minimal (Zürich centre):

```yaml
sources:
  - name: source-homegate
    enabled: true
    config:
      search:
        location: { lat: 47.36667, lon: 8.55 }
```

Family-of-four hunt in Witikon, 3+ rooms, ≤ CHF 5'000:

```yaml
sources:
  - name: source-homegate
    enabled: true
    config:
      search:
        location: { lat: 47.36, lon: 8.59, radius_m: 2000 }
        monthly_rent: { to: 5000 }
        number_of_rooms: { from: 3 }
        living_space: { from: 80 }
```

Aggressive scan (one minute cadence, smaller pages):

```yaml
sources:
  - name: source-homegate
    enabled: true
    config:
      schedule: "*/1 * * * *"
      fetch:
        page_size: 25
        max_pages: 10
        pace_ms: 2500
        backoff:
          retries: 5
          base_ms: 1500
```

## Troubleshooting

- **`homegate auth 401`** or **`homegate auth 403`** — the bundled
  Basic-Auth password or HMAC secret has been rotated upstream. Refresh
  the values via the mitmproxy procedure below and override
  `auth.basic_pass` / `auth.app_secret` in your config.
- **All `X-App-Id` headers are identical for many seconds** — by design:
  the header is bucketed per minute (`ceil(epoch/60)`). It rotates once
  per minute.
- **Empty results but no error** — the search bounding box may be too
  tight or the category filter too narrow. Widen `radius_m` or include
  more categories (`MAISONETTE`, `ATTIC_FLAT`, `ROOF_FLAT`, …).
- **`homegate rate limit`** — back off. Increase `fetch.pace_ms`,
  decrease `fetch.max_pages`, or set a less aggressive `schedule`.
- **`homegate status 5xx`** — transient upstream issue; the retry policy
  handles it. If it persists, the orchestrator's per-source circuit
  breaker will pause the source.
- **Algorithm drift** — if Homegate changes the `X-App-Id` formula,
  every request will 401. Re-run the mitmproxy capture, decompile the
  fresh APK with `apktool` / `jadx`, and update `src/auth.ts`. The
  reference Rust code may already have the fix.

## Refreshing credentials (mitmproxy procedure)

When Homegate rotates the public Basic-Auth password or the HMAC secret,
capture fresh values from the official Android app:

1. **Install mitmproxy** on a host on your LAN:
   ```bash
   pip install mitmproxy   # or:  brew install mitmproxy
   mitmweb --listen-port 8080
   ```
2. **Point the Android device at the proxy.** On the device, set the
   Wi-Fi proxy to `<host>:8080`, then visit `http://mitm.it` and install
   the mitmproxy root CA.
3. **Bypass SSL pinning.** Modern Homegate APKs pin TLS. Use one of:
   - A rooted device with `Magisk` + `LSPosed` + `JustTrustMe`, or
   - Patch the APK with `apk-mitm` (`npx apk-mitm app.apk`) and sideload
     the patched APK, or
   - Use `Frida` with a "universal SSL pinning bypass" script.
4. **Open the Homegate app and search.** In mitmweb, filter for
   `~u api.homegate.ch`. Inspect a `POST /search/listings` request.
5. **Extract the headers:**
   - `Authorization: Basic <b64>` — `base64-decode` → `<user>:<password>`.
     Replace `auth.basic_user` and `auth.basic_pass`.
   - `User-Agent: …` — replace `auth.user_agent`.
   - `X-App-Version: Homegate/<X.Y.Z>/<build>/Android/<sdk>` — replace
     `auth.app_version`.
6. **Extract the HMAC secret.** The `X-App-Id` header itself is the
   *output* of the algorithm, not the secret. To get the secret you must
   decompile the APK:
   ```bash
   jadx --deobf homegate.apk -d ./decompiled
   rg -ni 'app_id|secret|hmac|SHA256'  ./decompiled
   ```
   Look for a hard-coded 16- to 32-byte array near the HMAC call site.
   Compare the surrounding code with
   [`homegate-rs/src/api/app_id.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/app_id.rs)
   to confirm the algorithm has not changed. If it has, update
   `src/auth.ts` accordingly.
7. **Verify** by re-running `pnpm --filter @wabe/source-homegate test`.
   If you also captured a real `X-App-Id` together with the exact
   request timestamp, you can add it as a regression vector in
   `test/auth.test.ts`.
8. **Override in your config** without forking the plugin:
   ```yaml
   sources:
     - name: source-homegate
       enabled: true
       config:
         auth:
           basic_pass: "<new-pass>"
           app_secret: "<new-secret>"
           app_version: "Homegate/<X.Y.Z>/<build>/Android/<sdk>"
   ```

## Rate-limit etiquette

Homegate is a small Swiss company; treat their backend with respect.

- Default cadence is `*/2 * * * *` (twice per minute *interval*, not
  twice per minute — that's a one-scan-every-two-minutes cron).
- Default `pace_ms = 5000` between pages, `max_pages = 3`. That is at
  most ~6 requests per scan, ~180 requests/hour.
- Set conservative bounding boxes; do not scan all of Switzerland on a
  one-minute schedule.

## Legal posture

This plugin talks to an **unofficial** API extracted from the official
Homegate mobile app. All listing data is the property of SMG Swiss
Marketplace Group Ltd (the owner of homegate.ch).

- **Personal use only.** Wabe is intended for personal apartment hunting.
- **Do not republish the data.** Aggregating listings into a third-party
  site or feed likely violates Homegate's ToS and Swiss copyright /
  unfair-competition law.
- **No commercial use** without explicit written permission from SMG.
- Your account or IP may be banned at any time without notice.

If you maintain a hosted multi-tenant deployment of Wabe, **disable this
source** and prefer official partner APIs.

## Attribution

This plugin is a TypeScript port of authentication and request shape
logic from
[`denysvitali/homegate-rs`](https://github.com/denysvitali/homegate-rs)
by Denys Vitali, licensed MIT. Specifically:

- HMAC `X-App-Id` algorithm:
  [`src/api/app_id.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/app_id.rs)
- Basic-Auth + header construction + Basic-Auth credentials:
  [`src/api/request.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/request.rs)
  and [`src/api/mod.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/mod.rs)
- Search request body shape:
  [`src/api/search.rs`](https://github.com/denysvitali/homegate-rs/blob/main/src/api/search.rs)

A hand-crafted, representative response fixture is captured in
[`test/fixtures/responses/zurich-page-1.json`](./test/fixtures/responses/zurich-page-1.json).
Live unit tests use inline fixtures and undici's `MockAgent`.

## License

AGPL-3.0-or-later, matching the rest of the Wabe project. The MIT
attribution above covers the *derived ideas and algorithm* ported from
`homegate-rs`; the resulting TypeScript code is distributed under
AGPL-3.0-or-later.
