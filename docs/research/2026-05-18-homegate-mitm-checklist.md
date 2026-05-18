---
date: 2026-05-18
status: prep
topic: Homegate mitmproxy capture — pre-flight checklist
---

# Homegate mitm capture checklist

Picks up where `2026-05-18-homegate-investigation.md` left off. The prior
session captured enough to confirm Homegate moved to Auth0 + DataDome +
Cloudflare; this session aims to capture **everything a TypeScript
re-implementation will need**, in one sitting, so we don't have to redo
the phone-cert dance later.

Read the investigation doc first — it lists the endpoints, redacted
header names, and the known unknowns we are filling in here.

## 0. Decision before starting

The investigation doc lists four implementation paths (A: headless
browser, B: full reverse-engineer, C: Apify, D: drop). Before the
capture, pick one — different choices need different data:

- **Option B (RE the iOS X-App-Id + DataDome bypass)** → capture
  everything below. Most data, most fragile.
- **Option A (stealth browser)** → only need search/detail endpoint
  shapes and response schemas, NOT app-side header generation or
  DataDome cookies. Skip §3 and §4.
- **Option C (Apify)** → no capture needed. Skip this session entirely.
- **Option D (drop)** → no capture needed. Close the loop in the spec.

Recommendation: **A**. DataDome solving is a moving target; the iOS
`X-App-Id` derivation is unknown and not in homegate-rs. A stealth
browser keeps the maintenance surface smaller and survives DataDome
rule updates without code changes. Capture is still useful for the
endpoint contract (response → canonical `Listing` mapping).

If picking A: only §1, §2, §5, §6 below are required.

## 1. Pre-flight (mac side)

- [ ] Confirm mac LAN IP is stable, note it for the proxy config. Last
  session: `192.168.1.34` — re-check before starting.
- [ ] `brew upgrade mitmproxy` — pin the major version in the spec so
  future sessions can reproduce.
- [ ] Disable any VPN, corporate proxy, or DNS rewriting on the mac
  (Tailscale, Cloudflare WARP, NextDNS, etc.) — they will interfere.
- [ ] Start `mitmweb --listen-port 8081 --no-web-open-browser`.
- [ ] In a second tab, open `http://127.0.0.1:8081/` to confirm the UI
  is reachable.
- [ ] Add a write-to-disk hook so flows survive a crash:
  `mitmweb --listen-port 8081 -w /tmp/homegate-$(date +%s).mitm`
- [ ] Free disk space ≥ 500 MB (some image responses are large).

## 2. Pre-flight (iPhone side)

- [ ] iPhone is on the same Wi-Fi network as the mac.
- [ ] **Cellular data off** for the session, otherwise iOS may bypass
  the Wi-Fi proxy for some requests.
- [ ] Settings → Wi-Fi → (network) → Configure Proxy → Manual:
  - Server: mac LAN IP (from §1)
  - Port: `8081`
  - Authentication: off
- [ ] Verify the mitmproxy CA cert is still trusted: Settings → General
  → About → Certificate Trust Settings. If not, re-install from
  `http://mitm.it` and toggle full trust on.
- [ ] Confirm Homegate iOS app is **logged out** before starting. We
  want to capture the login flow from scratch.
- [ ] If iOS version or Homegate app version changed since the last
  capture, note both — the `X-App-Version` header reflects them.

## 3. Capture protocol — auth (skip if Option A)

Capture **in order**. Don't multi-task in the app; let each flow finish
before triggering the next.

- [ ] **3.1 Cold-start login.** Force-quit the Homegate app. Re-open.
  Tap "Sign in with Google", complete the SSO flow. Watch for:
  - `POST https://auth.homegate.ch/authorize` (and any /co/authenticate
    or similar Auth0 helpers).
  - `POST https://auth.homegate.ch/oauth/token` — capture the full
    response body, including `access_token`, `id_token`, `refresh_token`,
    `expires_in`. **Redact everything before saving the doc.**
- [ ] **3.2 Token refresh.** Leave the app idle 30+ minutes, then
  trigger any user-bound action (open Favourites). Capture the
  refresh-token request — confirm the new refresh token is returned and
  the old one is invalidated.
- [ ] **3.3 Decode the id_token JWT** (no server call needed — paste
  into `jwt.io` offline-mode). Note the issuer, audience, `azp`, `sub`
  format. Confirms which Auth0 application we are talking to.

## 4. Capture protocol — anti-bot (skip if Option A)

- [ ] **4.1 First DataDome challenge.** Clear app data so cookies are
  fresh. Open Homegate, run a search. The first request to
  `api.homegate.ch` triggers the DataDome handshake — capture the
  initial 403, the challenge response, and the eventual 200. Note
  the `Set-Cookie: datadome=...; Max-Age=...` lifetime.
- [ ] **4.2 Cloudflare bot management.** Same flow yields a
  `__cf_bm` cookie. Note the lifetime.
- [ ] **4.3 TLS fingerprint.** Note the iOS app's TLS handshake:
  - Tools panel in mitmproxy shows the negotiated cipher suite.
  - If we go Option B, we'll need to match this from Node (curl-impersonate
    or undici with a custom TLS config) — record JA3 fingerprint if
    visible.
- [ ] **4.4 X-App-Id derivation.** Trigger 10+ search requests
  back-to-back; collect every `X-App-Id` value emitted. Look for:
  - Length (digits only? hex? base64?)
  - Monotonic / random / deterministic per session
  - Correlation with `X-UDID` (constant) or request body
  - If we can't derive the algorithm in 30 minutes of inspection, drop
    to Option A.

## 5. Capture protocol — endpoint contracts (always required)

These pin down what data Homegate actually returns, so the response →
`Listing` mapper can be written without speculation.

- [ ] **5.1 Search by zipcode.** Run a search in the app with the
  same filters as the slice's reference config:
  - Cities: Zürich (any 80xx zipcode)
  - Rooms: 3+
  - Price max: 5000 CHF
  - Surface min: 60 m²
  Capture the request body verbatim. Note the geo-tag vocabulary:
  `geo-zipcode-NNNN`, `geo-city-...`, `geo-canton-...`, `geo-region-...`.
- [ ] **5.2 Search by city.** Switch the location filter to a city
  picker. Confirm whether the geo-tag is `geo-city-zurich` or something
  else; record the exact slug.
- [ ] **5.3 Search by radius.** If the iOS app has a "draw on map" or
  radius picker, exercise it. Capture the resulting `location` block
  shape — there may be a `lat`/`lon`/`radius_m` variant alongside
  geo-tags.
- [ ] **5.4 Multi-page.** Scroll the search results until pagination
  triggers (`from` and `size` increment). Confirm `total` matches the
  on-screen count.
- [ ] **5.5 Listing detail / batch.** Tap a result, scroll the detail
  page. Capture:
  - The `listings/listings?ids=...&fieldset=...` request (note all
    fieldset values surfaced — at minimum `srp-list` and a "full" one).
  - Compare the field set returned vs `srp-list` to see which carries
    `description`, `images[]`, `coordinates`, agency info, etc.
- [ ] **5.6 Photos.** Note the image URL pattern:
  - Host(s) (looks like `https://media.homegate.ch/...`)
  - Path shape (UUID, hash, includes a transform/size key?)
  - Whether they're protected (signed URLs / referrer headers needed).
- [ ] **5.7 Furnished / temporary flags.** Check the response for
  fields that map to our `rental_term` classifier:
  - `isFurnished` / `is_temporary` / `categories[]` etc. The investigation
    doc speculated these exist; confirm.
- [ ] **5.8 Address / coordinates.** Confirm whether `street`,
  `zipcode`, `latitude`, `longitude` are top-level or nested under
  `address` / `geo`.

## 6. Post-capture deliverables

Before tearing down the proxy session, produce three artefacts:

- [ ] **6.1 Response samples (anonymised)** — at least three search
  responses (small, medium, large `total`) and at least three detail
  responses (one furnished, one `befristet`, one plain long-term).
  Save under `plugins/source-homegate/test/fixtures/responses/` once
  the plugin package is created. Strip out any user-bound fields
  (favourited flags, viewed-by-me, etc.) before committing.
- [ ] **6.2 Field-mapping table** — drafted directly into the plan
  doc. One row per `Listing` field, source path on the Homegate side,
  notes on how to handle missing values. Mirrors the table at the top
  of `plugins/source-flatfox/src/map.ts`.
- [ ] **6.3 A spec doc** — `docs/superpowers/specs/<date>-source-homegate-v2-design.md`
  that picks one of options A–D and freezes the choice. Plan can be
  written from the spec via `superpowers:writing-plans`.

## 7. Tear-down

- [ ] iPhone → Settings → Wi-Fi → (network) → Configure Proxy → Off.
- [ ] Optional: remove the mitmproxy CA from Cert Trust Settings.
- [ ] Stop mitmweb. Move the `.mitm` flow file to
  `~/.local/share/wabe/captures/` (gitignored) for later inspection;
  do NOT commit raw captures.
- [ ] Log out of the Homegate app — refresh tokens captured during the
  session are now in flow files; invalidate them.

## 8. Security reminders

- Never paste captured tokens (Bearer JWTs, refresh tokens, DataDome
  cookies) into chat, commits, or the spec doc. Treat them like
  passwords.
- The captured `.mitm` flow files contain raw secrets. Keep them on
  the local disk only.
- If a token does end up somewhere it shouldn't:
  - Bearer / refresh token → log out in the Homegate app (rotates the
    refresh token and invalidates the leaked one).
  - DataDome cookie → no rotation possible; wait for `Max-Age` to
    expire, or clear app data on the phone (forces a new challenge).

## 9. Time budget

- mac side prep: 10 min
- iPhone side prep: 10 min
- Option-A capture (§5 only): 30 min
- Option-B capture (full): 90 min
- Post-capture write-up (§6): 60 min

If Option A is chosen, the whole session fits in ~2 hours including
write-up. If Option B, plan for an afternoon.
