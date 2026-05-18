# Homegate Source + User OAuth — Design Spec

> Status: **captured**, ready for implementation. Three-phase ship sequence detailed below.

## Context

Wabe ships today with one source: `@wabe/source-flatfox`. To deliver real Swiss coverage we need at minimum a second portal. The largest gap is **Homegate** — the dominant SRP in the Swiss market.

The Homegate iOS app was reverse-engineered via mitmproxy on 2026-05-18. Findings live in `docs/research/2026-05-18-homegate-capture-findings.md`. Two things were learned that shape this spec:

1. **Search is anonymous** but gated by DataDome + Cloudflare cookies. Cookies are session-bound to IP/TLS fingerprint — they cannot be copy-pasted from a phone into Node. A real browser must harvest them.
2. **User-bound endpoints** (favorites, contact-agency, profile) require Auth0 OAuth2 + PKCE with the iOS app's `client_id`. The redirect URI is a custom scheme `homegate://login/redirect`. We don't own the Auth0 application; the only viable desktop flow is OOB copy-paste of the failed-redirect URL.

These two surfaces are independent on the wire but ship together so the next applicator-plugin spec doesn't need to redo the OAuth research.

**Deliverables:**
- `@wabe/browser-runtime` — new shared package wrapping Playwright + stealth. Reusable for any future portal that puts an anti-bot stack in front of a public API.
- `@wabe/source-homegate` — read-only Source plugin. Uses `browser-runtime` to bootstrap DataDome cookies once; runs all subsequent search/detail requests as cheap undici HTTP. Auto-rebootstrap on 403.
- `wabe login homegate` CLI command — OOB OAuth2+PKCE flow. Persists refresh token in `${dataDir}/secrets.json` (mode 0600). Token is consumed by source-homegate when the plugin needs a user-bound call (future applicator), and surfaced via a `getUserToken('homegate')` helper.
- `wabe logout homegate` CLI command — revoke + delete stored token.
- `wabe doctor` extension — surface bootstrap-cookie age, secrets file presence, OAuth token validity.

**Out of scope (deferred):**
- Applicator (sending applications from wabe) — separate spec; this spec only stores tokens.
- ImmoScout24 / Comparis / other DataDome-gated portals — `browser-runtime` is designed to make those cheap, but each gets its own source spec.
- Map/radius/canton geoTag forms on Homegate — captured zipcode form covers the slice's reference config.
- Detail-batch `pdp-full` fieldset — not captured; staying on `srp-list` for v1. Flagged as known unknown.

## Architecture summary

```
┌─────────────────────────┐
│  wabe CLI               │
│  ├─ login homegate      │──┐         (OOB OAuth, PKCE, S256)
│  ├─ logout homegate     │  │
│  ├─ doctor (extended)   │  │
│  └─ scan / start        │  │
└────────┬────────────────┘  │
         │                    ▼
         │            ┌──────────────────┐
         │            │ secrets.json     │  ← 0600, atomic write
         │            │ (refresh tokens) │
         │            └──────────────────┘
         ▼
┌─────────────────────────────────────────────┐
│ @wabe/server (orchestrator, unchanged)      │
└────────┬────────────────────────────────────┘
         │ dynamic import
         ▼
┌─────────────────────────────────────────────┐
│ @wabe/source-homegate                       │
│                                             │
│   auth.ts ─────► reads secrets.json         │
│                  refreshes access_token     │
│                  (1800s TTL)                │
│                                             │
│   client.ts ───► undici + DataDome cookies  │
│                  + X-App-Id nonce           │
│                  + X-UDID + UA + Priority   │
│                  ├── 200 → search results   │
│                  └── 403 → trigger bootstrap│
│                                             │
│   bootstrap.ts ─► uses @wabe/browser-runtime│
│                  to harvest cookies,        │
│                  persists to data-dir       │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ @wabe/browser-runtime  (shared infra)       │
│                                             │
│   stealth.ts ──► playwright-extra +         │
│                  puppeteer-extra-plugin-    │
│                  stealth                    │
│   bootstrap.ts ─► visit URL, return Cookie  │
│                   header value              │
│   pool.ts      ─► (Phase 3) warm-browser    │
│                   resident in `wabe start`  │
└─────────────────────────────────────────────┘
```

**Why this shape:**
- Browser is paid once per cookie-lifetime (~hours/days), not per scan. Steady-state scans stay ~10MB undici.
- `browser-runtime` is generic — next portal (ImmoScout24, also DataDome) reuses it. AGPL-clean: Playwright Apache-2, stealth plugin MIT.
- DataDome cookies + OAuth tokens are orthogonal: anonymous search doesn't need login; user-bound endpoints don't need DataDome (Bearer-authed paths bypass DD per the capture). The plugin only attaches Auth when calling user-bound endpoints (none in v1 read-only slice, but the plumbing ships now).
- Secret store is a flat JSON file, not a YAML/env file, so atomic rewrite on token rotation is trivial: write tmp + rename. No race with user editing config.

## File-by-file changes

### Phase 1 — `@wabe/browser-runtime`

Goal: ship the shared infra in isolation. End-of-phase verification: harvest cookies from `httpbin.org/cookies` in a unit test.

- **Create** `packages/browser-runtime/package.json`
  ```json
  {
    "name": "@wabe/browser-runtime",
    "version": "0.1.0",
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "license": "AGPL-3.0-or-later",
    "dependencies": {
      "playwright": "^1.49.0",
      "playwright-extra": "^4.3.6",
      "puppeteer-extra-plugin-stealth": "^2.11.2",
      "pino": "*"
    },
    "scripts": {
      "build": "tsc -p tsconfig.json",
      "test": "vitest run"
    }
  }
  ```
  Chromium install is **lazy** (on first `bootstrap()` call) — postinstall would slow every workspace install and break CI. Document the 300MB download in plugin README.

- **Create** `packages/browser-runtime/src/stealth.ts`
  - Export `getStealthBrowser(opts?: { headless?: boolean }): Promise<Browser>`.
  - Wraps `chromium.use(StealthPlugin())` then `chromium.launch()`. Closes on `Browser` API.
  - Pure thin wrapper; no business logic.

- **Create** `packages/browser-runtime/src/bootstrap.ts`
  ```ts
  export interface BootstrapResult {
    cookieHeader: string;            // ready-to-attach Cookie: header
    cookies: { name: string; value: string; domain: string; expires: number | null }[];
    capturedAt: number;              // epoch ms
    userAgent: string;               // the Chromium UA used
  }
  export interface BootstrapOptions {
    target: string;                  // e.g. 'https://www.homegate.ch/rent'
    waitFor?: string;                // selector to wait for
    timeoutMs?: number;              // default 30_000
    logger?: pino.Logger;
  }
  export async function bootstrapSite(opts: BootstrapOptions): Promise<BootstrapResult>;
  ```
  - Launches stealth browser, navigates, waits for `networkidle` (or `waitFor` selector if given), collects all cookies whose domain matches `opts.target`'s host (`.homegate.ch` and `.www.homegate.ch`), formats into a single `Cookie:` header value, returns.
  - Closes browser before return. Throws `BootstrapTimeoutError` on timeout.

- **Create** `packages/browser-runtime/src/index.ts` — barrel: re-export `bootstrapSite`, `getStealthBrowser`, error types.

- **Create** `packages/browser-runtime/tsconfig.json` — extends root tsconfig pattern from other packages.

- **Create** `packages/browser-runtime/test/bootstrap.test.ts`
  - One test gated by `it.skipIf(!process.env.WABE_E2E)`: hits `https://httpbin.org/cookies/set?test=ok` and asserts `cookieHeader` contains `test=ok`.
  - Reason for skip: live network in CI is banned (CLAUDE.md). Test runs locally on demand.

### Phase 2 — `@wabe/source-homegate` (anonymous search)

Goal: read-only search works end-to-end with auto-bootstrap. No OAuth yet.

- **Create** `plugins/source-homegate/package.json`
  ```json
  {
    "name": "@wabe/source-homegate",
    "version": "0.1.0",
    "type": "module",
    "main": "./dist/index.js",
    "license": "AGPL-3.0-or-later",
    "dependencies": {
      "@wabe/core": "workspace:*",
      "@wabe/plugin-sdk": "workspace:*",
      "@wabe/browser-runtime": "workspace:*",
      "undici": "*",
      "zod": "*",
      "pino": "*"
    }
  }
  ```

- **Create** `plugins/source-homegate/src/headers.ts`
  - Constants (per-install, generated once and persisted to `${dataDir}/homegate-install.json` on first run):
    - `X_UDID` — UUIDv4 generated via `crypto.randomUUID()`.
    - `USER_AGENT` — `ch.homegate.Homegate/15.62.0 (iPhone, iOS 26.4.2, Scale 3.00)` (pinned to captured version; update when re-captured).
    - `X_APP_VERSION` — `Homegate/15.62.0/iPhone/iOS/23`.
  - `newXAppId(): string` — verbatim from findings doc:
    ```ts
    export function newXAppId(): string {
      const buf = crypto.randomBytes(12);
      const n = (buf.readBigUInt64BE() << 32n) | BigInt(buf.readUInt32BE(8));
      return (n % 10n ** 26n).toString(10);
    }
    ```
  - `buildHeaders({ cookie, bearer? }): Record<string, string>` — assembles full header set per-request. `Priority: u=3` constant, `X-App-Id` regenerated per call.

- **Create** `plugins/source-homegate/src/install.ts`
  - `getInstall(dataDir: string): { xUdid: string; userAgent: string; xAppVersion: string }`.
  - Reads `${dataDir}/homegate-install.json`. If missing, generates a fresh `xUdid`, writes the file with 0600 perms, returns. Reusable across runs to keep the per-install identity stable.

- **Create** `plugins/source-homegate/src/cookies.ts`
  - `loadCookies(dataDir): Promise<BootstrapResult | null>` — reads `${dataDir}/homegate-cookies.json` if present, returns null otherwise.
  - `saveCookies(dataDir, result): Promise<void>` — atomic write (`${path}.tmp` + rename), 0600.
  - `isCookieFresh(result, maxAgeMs = 12 * 3600_000): boolean` — true if `capturedAt + maxAgeMs > Date.now()`.

- **Create** `plugins/source-homegate/src/bootstrap.ts`
  - `ensureBootstrap(dataDir, logger, opts?: { force?: boolean }): Promise<BootstrapResult>` — load → if fresh and not forced, return; else call `bootstrapSite({ target: 'https://www.homegate.ch/rent', waitFor: 'body', timeoutMs: 45_000 })` → save → return.
  - Wrapped in a per-process async lock so concurrent calls (parallel sources in `wabe start`) don't double-bootstrap.

- **Create** `plugins/source-homegate/src/client.ts`
  - `fetchSearch(body: SearchRequest, ctx: ClientContext): Promise<SearchResponse>`.
  - Pattern: undici `request()` (global dispatcher for MockAgent testability, matching source-flatfox).
  - Retry loop on `[429, 500, 502, 503, 504]` with exponential backoff (`base_ms * 2^attempt`). Same shape as `plugins/source-flatfox/src/client.ts`.
  - **Special case 403** — single retry: invalidate stored cookies, call `ensureBootstrap()` with `force: true`, retry once with new cookies. If second 403 → throw `HomegateAntiBotError`.
  - Honors `ctx.signal` for abort. Pacing between page requests via `sleep(ms, signal)`.

- **Create** `plugins/source-homegate/src/search.ts`
  - `SearchConfig` Zod schema:
    ```ts
    export const SearchConfig = z.object({
      zipcodes: z.array(z.number().int().min(1000).max(9999)).default([]),
      price_max: z.number().int().positive().optional(),
      price_min: z.number().int().positive().optional(),
      rooms_min: z.number().positive().optional(),
      rooms_max: z.number().positive().optional(),
      surface_min: z.number().int().positive().optional(),
      property_type: z.enum(['APARTMENT_OR_HOUSE', 'APARTMENT', 'HOUSE']).default('APARTMENT_OR_HOUSE'),
      offer_type: z.literal('RENT').default('RENT'),
      has_balcony: z.boolean().optional(),
      has_elevator: z.boolean().optional(),
      sort_by: z.enum(['dateCreated', 'price', 'roomCount', 'livingSpace']).default('dateCreated'),
      sort_direction: z.enum(['asc', 'desc']).default('desc'),
    });
    ```
  - `buildSearchBody(cfg, page_size, from): SearchRequest` — translates to the captured POST body shape (`query.location.geoTags = zipcodes.map(z => "geo-zipcode-" + z)`, `query.monthlyRent.to = price_max`, etc.). Only emits fields the user set — empty objects elided to match iOS app shape.

- **Create** `plugins/source-homegate/src/map.ts`
  - `mapHomegateResult(r: HomegateResultEnvelope): RawListing` — implements the mapper table from the findings doc:

    | Canonical field            | Source path                                                       | Notes |
    | --- | --- | --- |
    | `id`                       | `"homegate:" + r.id`                                              | |
    | `source`                   | `"homegate"`                                                       | constant |
    | `url`                      | `https://www.homegate.ch/rent/${r.id}`                            | verify on first scan |
    | `price.rent_net`           | `r.listing.prices.rent.net`                                       | nullable |
    | `price.extras`             | `r.listing.prices.rent.extra`                                     | nullable |
    | `price.total`              | `r.listing.prices.rent.gross`                                     | |
    | `price.currency`           | `r.listing.prices.currency`                                       | usually `"CHF"` |
    | `rooms`                    | `r.listing.characteristics.numberOfRooms`                         | |
    | `area_m2`                  | `r.listing.characteristics.livingSpace`                           | |
    | `floor`                    | `r.listing.characteristics.floor`                                 | nullable |
    | `built_year`               | `r.listing.characteristics.yearBuilt`                             | nullable |
    | `renovated_year`           | `r.listing.characteristics.yearLastRenovated`                     | nullable |
    | `location.coords`          | `[lat, lon]` from `r.listing.address.geoCoordinates`              | null if missing |
    | `location.address`         | `r.listing.address.street`                                        | nullable |
    | `location.postal_code`     | `r.listing.address.postalCode`                                    | |
    | `location.city`            | `r.listing.address.locality`                                      | |
    | `location.country`         | `"CH"`                                                             | constant |
    | `description`              | `r.listing.localization[primary].text.description`                | |
    | `photos`                   | `localization[primary].attachments.filter(a => a.type === 'IMAGE').map(a => a.url)` | absolute URLs |
    | `available_from`           | not present in `srp-list` — null                                  | TODO when pdp-full captured |
    | `lease_until`              | `classifyRentalTerm(description).lease_until`                     | classifier reused from `@wabe/core` |
    | `rental_term`              | `classifyRentalTerm(description).rental_term`                     | |
    | `features.has_parking`     | `r.listing.characteristics.hasParking`                            | |
    | `features.has_garage`      | `r.listing.characteristics.hasGarage`                             | |
    | `features.pets_allowed`    | `r.listing.characteristics.arePetsAllowed`                        | |

  - Strict `HomegateApiSchema` Zod definition co-located, with `passthrough()` on the inner `listing` object so unexpected fields don't blow up scans.

- **Create** `plugins/source-homegate/src/auth.ts`
  - `getAccessToken(secretsStore, logger): Promise<string | null>` — reads secrets, returns null if not logged in. If access token expired (`accessTokenExpiresAt < now + 60_000`), POSTs to `https://auth.homegate.ch/oauth/token` with grant_type=refresh_token, swaps the rotated tokens back into secrets via atomic write, returns the new access token.
  - This module is wired but **not yet called** by Phase 2's read-only client (search is anonymous). It exists to keep the plugin self-contained and to be unit-testable independently. The applicator-spec will be its consumer.

- **Create** `plugins/source-homegate/src/errors.ts`
  - `HomegateHttpError`, `HomegateAntiBotError`, `HomegateAuthError`, `HomegateParseError`.

- **Create** `plugins/source-homegate/src/index.ts`
  - Top-level `ConfigSchema`:
    ```ts
    const FetchConfig = z.object({
      page_size: z.number().int().positive().max(50).default(20),
      max_pages: z.number().int().positive().default(5),
      pace_ms: z.number().int().nonnegative().default(2500),
      cookie_max_age_hours: z.number().positive().default(12),
      backoff: z.object({
        on: z.array(z.number()).default([429, 500, 502, 503, 504]),
        retries: z.number().int().nonnegative().default(3),
        base_ms: z.number().int().positive().default(2000),
      }).default({}),
    });
    const ConfigSchema = z.object({
      schedule: z.string().default('*/5 * * * *'),
      search: SearchConfig.default({}),
      fetch: FetchConfig.default({}),
    });
    ```
  - `plugin: Source` — async generator iterates pages (`from = page * page_size`), maps each result, yields. Stops when `from >= total` or `from >= maxFrom` (Homegate enforces a hard cap).
  - Schedule default `*/5 * * * *` — Homegate updates less frequently than Flatfox and we want to minimise DataDome attention. Reference config in `examples/zurich-family/` will use `*/15 * * * *`.

- **Create** `plugins/source-homegate/test/headers.test.ts`
  - `newXAppId()` — 1000 samples, all match `^\d{1,26}$`, all distinct, top-bit sanity check.

- **Create** `plugins/source-homegate/test/cookies.test.ts`
  - Atomic write + reload roundtrip; `isCookieFresh` boundary at exact cutoff.

- **Create** `plugins/source-homegate/test/client.test.ts`
  - MockAgent: 200 happy path → emit results.
  - MockAgent: 403 first, 200 second → bootstrap is triggered exactly once and the second request uses fresh cookies.
  - MockAgent: 403 + 403 → throws `HomegateAntiBotError`.
  - MockAgent: 429/503 retry budget + exponential backoff.

- **Create** `plugins/source-homegate/test/map.test.ts`
  - Three fixtures: vanilla 4.5-room, furnished sublet (`description: '... möbliert ...'` → `rental_term: 'short'`), `befristet bis 31.12.2027` (parses `lease_until`).
  - Fixtures: `plugins/source-homegate/test/fixtures/responses/search-zurich-page-0.json` (anonymised real capture — strip listerBranding logos, scrub addresses to street-name only).

- **Create** `plugins/source-homegate/test/auth.test.ts`
  - MockAgent: refresh-token grant returns new tokens → access token and refresh token both updated in the secrets stub.
  - Refresh failure (401 invalid_grant) → `HomegateAuthError`, secrets file untouched.

- **Create** `plugins/source-homegate/README.md`
  - Mirror `plugins/source-flatfox/README.md` structure (What it is / Install / Config reference table / Examples / Troubleshooting / Attribution / License).
  - Explicit sections:
    - "First run downloads ~300MB Chromium via Playwright." (one-time, lazy-installed on first `bootstrap()`).
    - "How DataDome cookies are managed" — 3-bullet explanation: harvested once, cached, auto-refreshed on 403.
    - "Optional: `wabe login homegate`" — pointer to CLI doc.
    - Troubleshooting: cookie 403 loop (`wabe doctor` shows cookie age; force re-bootstrap with `rm ${dataDir}/homegate-cookies.json`).

- **Modify** `packages/server/package.json`
  - Add `"@wabe/source-homegate": "workspace:*"` to `dependencies` (per CLAUDE.md slice convention — server's dynamic `import()` resolves from its `node_modules/`).

### Phase 3 — User OAuth (`wabe login homegate`)

Goal: user logs in via OOB copy-paste, refresh token persists, doctor surfaces status.

- **Create** `packages/server/src/secrets.ts`
  - `interface SecretsFile { homegate?: { refreshToken: string; accessToken: string; accessTokenExpiresAt: number; idToken?: string; userSub?: string; loggedInAt: number } }`
  - `loadSecrets(dataDir): SecretsFile` — reads `${dataDir}/secrets.json`, returns `{}` if missing.
  - `saveSecrets(dataDir, secrets): void` — atomic write (tmp + rename), `fs.chmodSync(path, 0o600)` post-rename.
  - `getHomegateRefreshToken(dataDir): string | null` / `setHomegateTokens(dataDir, tokens)` — narrow helpers consumed by `plugins/source-homegate/src/auth.ts`.

- **Create** `packages/cli/src/commands/login.ts`
  - `commander` subcommand: `wabe login <provider>`. Initial supported value: `homegate`.
  - Flow:
    1. `p.intro('login → homegate')`.
    2. `crypto.randomBytes(32)` → `code_verifier`. SHA-256 → base64url → `code_challenge`. `crypto.randomBytes(16)` → `state`.
    3. Build URL with the captured constants (`AUTH_BASE = 'https://auth.homegate.ch'`, `CLIENT_ID = 'lU7SBprOA383MV4TCsRfP9wUPc4JAcy1'`, `REDIRECT_URI = 'homegate://login/redirect'`, `SCOPE = 'openid profile email offline_access'`, `AUDIENCE = 'https://api.homegate.ch'`).
    4. Print the URL. Attempt to open it (`import open from 'open'` — already AGPL-compat MIT). Print fallback instructions if open fails.
    5. `p.text({ message: 'Paste the FULL URL the browser tried to navigate to' })`. Validate it starts with `homegate://login/redirect?`. Parse `code` and returned `state`. Reject on mismatch.
    6. POST to `https://auth.homegate.ch/oauth/token` with `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`. Use undici `request` directly — short-lived, no plugin context.
    7. Persist via `setHomegateTokens()`. Print `✓ logged in as <id_token.sub or email>`.
  - Error paths: timeout (5 min on paste prompt), bad URL, state mismatch, token-exchange failure — all printed cleanly via `p.cancel(...)` and exit 1.
  - **Security:** never log the access/refresh token contents. Only log `sub`, `email` if present in id_token, and expiry.

- **Create** `packages/cli/src/commands/logout.ts`
  - `wabe logout homegate` — calls `https://auth.homegate.ch/v2/logout` with `client_id` (best-effort revoke), then deletes the `homegate` key from secrets and persists.
  - Confirms with `p.confirm({ message: 'Revoke Homegate refresh token?' })` before proceeding.

- **Modify** `packages/cli/src/index.ts`
  - Register both new commands. Match existing `program.command(...)` pattern.

- **Modify** `packages/cli/src/commands/doctor.ts`
  - Add three checks at the end of the existing checks:
    - `result('homegate-install.json present', exists, path)` — informational, not a failure.
    - `result('homegate cookies fresh', isFresh, 'captured ' + relativeTime(capturedAt))` — warning (not fail) if missing or stale.
    - `result('homegate user token', !!refreshToken, refreshToken ? 'logged in as ' + sub : 'not logged in (optional)')` — informational, never fails.

- **Create** `packages/cli/test/login.test.ts`
  - PKCE: `code_verifier` → expected `code_challenge` deterministic for a fixed verifier.
  - URL parser: rejects URLs without `code`, rejects state mismatch, accepts the happy case.
  - Token-exchange MockAgent: returns a stub token bundle → asserts secrets file contains expected fields.

- **Create** `examples/zurich-family/config/plugins/source-homegate.yaml`
  - With schema header comment (generated JSON Schema picked up automatically by zod-to-json-schema once `ConfigSchema` is exported from the plugin).
  - `zipcodes: [8001, 8002, 8003, 8004, 8005, 8006, 8008, 8032]`, `price_max: 4500`, `rooms_min: 3`, `surface_min: 80`, `has_elevator: true`. Mirrors the captured iOS query.

- **Modify** `examples/zurich-family/config.yaml`
  - Add the homegate source to `enabled.sources`:
    ```yaml
    enabled:
      sources:
        - { name: flatfox,  plugin: source-flatfox,  config: plugins/source-flatfox.yaml }
        - { name: homegate, plugin: source-homegate, config: plugins/source-homegate.yaml }
    ```

- **Modify** `examples/zurich-family/test/config.test.ts` (or equivalent gate test)
  - Assert source-homegate config parses against its Zod schema.
  - Assert mapper field coverage gate still passes (the new `RawListing` keys homegate populates are a subset of those Flatfox already populates).

- **Modify** root `README.md`
  - Under "Sources" section: add `@wabe/source-homegate` entry with the same shape as the existing Flatfox row.
  - Under "First run" / "Setup": one-line note that Homegate triggers a Chromium download on first scan, and an optional `wabe login homegate` step for users who want to wire applicator features later.

- **Modify** `.gitignore`
  - Add `secrets.json`, `homegate-cookies.json`, `homegate-install.json` (defensive — these live in `${dataDir}`, normally outside the repo, but a future contributor running with `WABE_DATA_DIR=./tmp` shouldn't accidentally commit secrets).

## Order of execution

Build phases sequentially. Each phase ends in a commit-able state with green CI.

1. **Phase 1 — browser-runtime.** Build the shared package, unit-test the bootstrap helper offline against a fixture HTML server. Manual smoke: `pnpm --filter @wabe/browser-runtime test` then a throwaway script calling `bootstrapSite({ target: 'https://httpbin.org/cookies/set?test=ok' })` to confirm a real Chromium launch returns the expected cookie. Commit: `feat(browser-runtime): playwright + stealth shared package`.

2. **Phase 2 — source-homegate read-only.** Build the plugin top-down: schemas → mapper (against captured fixtures) → client (mocked) → bootstrap wiring → index.ts. Integration verification:
   - `pnpm --filter @wabe/source-homegate test` — all unit tests green.
   - `pnpm --filter @wabe/server test` — existing pipeline integration test still passes (homegate is not yet wired into the gate test).
   - Manual: fresh data-dir, `pnpm wabe scan --source homegate` — confirm Chromium launches once, cookies persist, listings appear in `wabe list`, including correct `rental_term` classification on a known furnished/befristet sample. Cross-source rental-term gate still works.
   Commit: `feat(source-homegate): anonymous search via DataDome bootstrap`.

3. **Phase 3 — OAuth login + doctor + examples.** Add `wabe login homegate`, `wabe logout homegate`, doctor checks, gitignore updates, example config wiring, root README update. Verification:
   - `pnpm wabe login homegate` interactively with a real Homegate account — confirm refresh token persists at `${dataDir}/secrets.json` with mode 0600 (`stat -f %A` on macOS → `600`).
   - `pnpm wabe doctor` — homegate cookie age + login status appear.
   - `pnpm wabe logout homegate` — secrets file's homegate key removed; revoke endpoint called.
   - `wabe scan --source homegate` continues to work whether logged in or not (Phase 2's anonymous search is unaffected).
   Commit: `feat(cli): wabe login homegate + secret store`.

Optional follow-up commit: `feat(examples): enable source-homegate in zurich-family` if not already folded into Phase 3.

Final `pnpm ci` clean.

## Critical files to read before starting

Phase 1:
- `packages/plugin-sdk/src/source.ts` — Source contract.
- `packages/core/src/engine/rental-term.ts` — classifier consumed by homegate's mapper.

Phase 2:
- `plugins/source-flatfox/src/client.ts` — retry/backoff loop shape to mirror.
- `plugins/source-flatfox/src/index.ts` — Source plugin entry-point shape.
- `plugins/source-flatfox/src/map.ts` — mapper structure (RawListing target).
- `plugins/source-flatfox/test/client.test.ts` — MockAgent pattern.
- `docs/research/2026-05-18-homegate-capture-findings.md` — endpoint, headers, mapper table, nonce algorithm.

Phase 3:
- `packages/cli/src/commands/init.ts` — `@clack/prompts` UX pattern + `writeEnvIfAbsent` parallel.
- `packages/cli/src/commands/doctor.ts` — `result(label, pass, detail)` style.
- `packages/cli/src/paths.ts` — XDG resolution; same path used for `secrets.json`.
- `packages/core/src/env.ts` — env interpolation (will NOT be touched, but understand why `secrets.json` is a separate path from `.env`).

## Verification

### Automated (`pnpm ci`)
- `@wabe/browser-runtime`: build + unit tests green (live test gated by `WABE_E2E`).
- `@wabe/source-homegate`: build + headers/cookies/client/map/auth unit tests green. Mock-driven; no live network.
- `@wabe/cli`: login unit tests (PKCE math, URL parsing, token-exchange mock) green.
- `@wabe/server`: existing integration test unchanged + green.
- `examples/zurich-family`: gate test green after adding homegate config.
- `tsc --noEmit`, `biome lint`, `biome format` all clean.

### Manual end-to-end

1. Clean data dir: `rm -rf ~/.local/share/wabe`.
2. `pnpm wabe init --example zurich-family` → choose Telegram bot config.
3. `pnpm wabe migrate`.
4. `pnpm wabe scan --source homegate` — observe in logs:
   - First-run Chromium download (one-time ~300MB).
   - `bootstrap: harvested 4 cookies from www.homegate.ch (datadome, __cf_bm, ...)`.
   - First HTTP request 200 OK; subsequent pages 200 OK.
   - N listings persisted.
5. `pnpm wabe list --source homegate --limit 5` → verify mapping (rooms, price, address, photos, term/until columns).
6. Force-expire cookies: edit `homegate-cookies.json`, set `capturedAt: 0`. Re-run scan → confirm bootstrap fires again, scan succeeds.
7. `pnpm wabe login homegate` interactively. Use a real Google SSO flow on the captured `client_id`. Paste the failed-navigation URL. Confirm `secrets.json` exists with the expected fields and mode 0600.
8. `pnpm wabe doctor` → all green, three new homegate rows present.
9. `pnpm wabe logout homegate` → confirm `secrets.json` no longer contains a `homegate` key.

### Acceptance

Feature is done when:
- A fresh user can `pnpm install && pnpm wabe init --example zurich-family && pnpm wabe scan` and see Homegate listings flow into their `wabe list` output and (with Telegram configured) into their chat alongside Flatfox listings.
- Rental-term filtering applies uniformly across both sources (the cross-source classifier wiring is the existing `@wabe/core` engine, not re-implemented).
- `wabe login homegate` succeeds against a real Homegate account, and the resulting refresh token survives `wabe scan` / `wabe start` lifecycle (rotation on refresh persisted atomically).
- No secret material appears in logs, commits, or fixtures.
- `pnpm ci` is green.

## Open questions to revisit before / during execution

- **Detail-page fieldsets** (`pdp-full`, `pdp-card`). Not captured. Mapper leaves `available_from` null. Either: (a) re-capture from the iOS app once the slice ships and follow up with a non-breaking field-coverage PR, or (b) parse `available_from` from description regex as a stop-gap (the existing rental-term lexicon partially covers it). Track as a TODO in the plugin's README "Known gaps".
- **Cookie lifetime in steady-state.** Findings say "hours"; the default `cookie_max_age_hours: 12` is a guess. First week of running will reveal the right value — if 403→bootstrap loops every scan, drop to `3`; if cookies last 24h cleanly, raise.
- **Pagination's `maxFrom` enforcement.** Findings mention but didn't pin down. Plugin treats `total` as authoritative and stops when results count drops below `page_size`. Add a defensive `maxFrom` check once observed in a real response.
- **Multi-account login.** v1 stores a single Homegate token. If the user wants per-search-profile accounts, the `secrets.json` shape (`homegate?: {...}`) can grow to `homegate?: Record<accountId, {...}>` without a breaking change to consumers.
