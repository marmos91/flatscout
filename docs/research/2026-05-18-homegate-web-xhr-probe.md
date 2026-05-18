---
date: 2026-05-18
status: findings
topic: Homegate web-XHR probe — DataDome CAPTCHA wall confirmed
related:
  - 2026-05-18-homegate-investigation.md
  - 2026-05-18-homegate-capture-findings.md
---

# Homegate web-XHR probe findings

After Phase 2 source-homegate's live smoke test confirmed
`api.homegate.ch/search/listings` returns 403 from undici despite valid
DataDome cookies harvested via headless Chromium, we ran a follow-up
probe (`packages/browser-runtime/scripts/probe-homegate-web.mjs`) to
test the "web-XHR backend" hypothesis: can we drive search from inside
the stealth Chromium itself, sidestepping the TLS-fingerprint binding?

## Setup

- Playwright + playwright-extra + puppeteer-extra-plugin-stealth
- Two runs: headless, headed (`HEADED=1`)
- Each run:
  1. Pre-warm `/rent` landing → harvests `datadome`, `cf_clearance`, `__cf_bm`
  2. `fetch('https://api.homegate.ch/search/listings', POST, JSON body)` from inside `page.evaluate()`
  3. Navigate to deep search URL `/rent/real-estate/canton-zurich/matching-list?ac=...`
  4. Scroll + paginate to trigger XHRs

## Results

### Headless run

- `/rent` landing: cookie set persisted (3 cookies harvested)
- In-context `fetch` to `api.homegate.ch/search/listings`: **403**
  - Body: a DataDome captcha-delivery URL `https://geo.captcha-delivery.com/captcha/?initialCid=...&referer=https%3A%2F%2Fapi.homegate.ch%2Fsearch%2Flistings...`
- Deep URL `matching-list` navigation: returned 2231-byte page (Cloudflare/DataDome interstitial), title `homegate.ch`, no hydration globals, zero search-result XHRs

### Headed run

- Same 403 on in-context `fetch` to `api.homegate.ch`, identical captcha-delivery URL shape
- Deep URL `matching-list`: 2231-byte interstitial again, but now `geo.captcha-delivery.com/captcha/check` also fires (CAPTCHA widget loaded) — never solved because the probe doesn't simulate user interaction
- No JSON-returning API endpoints from any homegate domain in the captured network log

## Interpretation

DataDome protects Homegate at two tiers:

1. **Low-friction tier** — `/rent` landing page issues `datadome=` cookie
   passively (no CAPTCHA). Sufficient for normal SPA browsing of the
   marketing surface. This is what Phase 2's bootstrap harvested.
2. **High-friction tier** — `api.homegate.ch/*` and the deep
   `/rent/.../matching-list` SSR URLs require a CAPTCHA-validated cookie.
   The low-friction cookie does NOT clear these endpoints.

The TLS-fingerprint hypothesis from the Phase 2 post-mortem was wrong
(or at least incomplete): even Chromium's own TLS stack, invoking
`fetch` from inside the page, hits 403 on `api.homegate.ch`. The
binding is to the **CAPTCHA solve event**, not the TLS handshake alone.

## Implications for `@wabe/source-homegate`

The plumbing built in Phase 2 (cookie harvest → undici replay → 403
retry with re-bootstrap → AntiBotError on persistent 403) works
correctly. The architectural shortcut "harvest cookies once, replay
cheaply with undici" cannot work for Homegate because the cookies the
bootstrap harvests are scope-limited to the marketing surface.

## Realistic paths forward

### Path A — interactive bootstrap (`wabe homegate-bootstrap`)

- New CLI command opens a real **headed** Chromium pointed at
  `homegate.ch/rent/.../matching-list?...`
- User manually solves the DataDome CAPTCHA (one click typically — the
  challenge is usually a "press and hold" puzzle)
- Cookies harvested from the CAPTCHA-passing session — these are the
  high-friction tier cookies that clear `api.homegate.ch`
- Cookies cached for `cookie_max_age_hours` (default 12h), but with the
  caveat that the user must rerun the bootstrap when they expire

Pros:
- Self-hosted personal use: ~once-a-day CAPTCHA solve is bearable
- No external dependencies, AGPL-clean
- Reuses Phase 2's plumbing (just replace the bootstrap call site)

Cons:
- Not "set and forget" — requires periodic user attention
- Headed Chromium means no headless server deployment without VNC/X11
- Cookie lifetime is an empirical guess (12h pulled from Phase 2 spec,
  not measured — DataDome cookies may rotate faster on high-friction
  endpoints)

Estimated effort: ~½ day to implement + write the spec.

### Path B — drop Homegate

- Mark `@wabe/source-homegate` as unsupported in the project README
- Keep `@wabe/browser-runtime` (it has no Homegate-specific code; the
  next portal that needs anti-bot bootstrap will use it)
- Update the spec doc to reflect the dead end

Pros:
- Honest. No half-working feature pretending to work.
- Removes maintenance burden of a fragile integration.

Cons:
- Wabe ships with only Flatfox as a source. That's a single-portal MVP.

### Path C — commercial DataDome bypass

Rejected: paid services, AGPL compatibility uncertain, fragile against
DataDome rule updates, against the project's self-hosted ethos.

## Recommendation

**Path A** for self-hosted personal use is the right answer. The CAPTCHA
solve is one-time-per-cookie-lifetime, not per-scan. Spec it as Phase 5
with explicit user-attended ceremony, and document the limitations
prominently in the plugin README so expectations match reality.

Phase 2's `source-homegate` plumbing stays in place — the only change
is swapping the `bootstrap.ts` call from headless harvest to a
headed-with-prompt flow, and surfacing a `wabe homegate-bootstrap` CLI
command users invoke before / between scans.

## Captured artefacts

JSON network captures under `docs/research/captures/`:
- `homegate-web-xhr-2026-05-18T13-29-00-867Z.json` (headless, no pre-warm)
- `homegate-web-xhr-2026-05-18T13-30-06-204Z.json` (headless, pre-warm)
- `homegate-web-xhr-2026-05-18T13-30-51-088Z.json` (headless, in-context fetch probe)
- `homegate-web-xhr-2026-05-18T13-31-37-007Z.json` (headed)

All contain only Cloudflare challenge-platform XHRs and DataDome
captcha-delivery 403s. No homegate search endpoint was reached
unauthenticated in any run.
