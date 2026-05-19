# @wabe/extension-wabe

Manifest v3 WebExtension that pairs with a local Wabe agent. The extension holds a WebSocket to `@wabe/browser-bridge` (running inside `wabe start`). On a bridge request, the extension opens (or reuses) a hidden tab loaded at the target's homepage, then injects a `fetch()` call into that tab via `chrome.scripting.executeScript({ world: 'MAIN' })`. The page's own hooked `window.fetch` runs the request — so anti-bot JS (DataDome on Homegate, Cloudflare on ImmoScout24) signs it normally, and the upstream sees a legitimate web-app call.

## Why a hidden tab, not just `fetch()` from the service worker?

A pure SW `fetch()` issues from the extension's own origin (`moz-extension://…` or `chrome-extension://…`), without any page-injected JS hooks. DataDome flags the missing `x-dd-…` header, returns a 403 fingerprint-error captcha redirect, and Wabe gets nothing useful. By running the fetch in MAIN world inside a page that DataDome has already JS-instrumented, we get the right header for free.

## Build

```
pnpm install
pnpm --filter @wabe/extension-wabe build          # builds both targets
# or one at a time:
pnpm --filter @wabe/extension-wabe build:chrome   # → dist/chrome/
pnpm --filter @wabe/extension-wabe build:firefox  # → dist/firefox/
```

Chrome MV3 requires `background.service_worker`; Firefox MV3 still ships with service workers disabled and requires `background.scripts` (event page). The two outputs are kept in separate `dist/<browser>/` subdirectories so they don't shadow each other.

## Install (Chrome)

1. Visit `chrome://extensions`.
2. Toggle "Developer mode" on (top-right).
3. Click "Load unpacked" and pick `apps/extension-wabe/dist/chrome/`.

## Install (Firefox)

1. Visit `about:debugging` → "This Firefox" → "Load Temporary Add-on".
2. Pick `apps/extension-wabe/dist/firefox/manifest.json`.
3. **Grant optional host permissions:** open `about:addons` → Wabe Bridge → Permissions, enable each of `homegate.ch`, `api.homegate.ch`, `immoscout24.ch`, `api.immoscout24.ch`. Firefox does not auto-grant MV3 host permissions; without these the bridge cannot `executeScript` against the target tabs.

(Firefox temporary add-ons unload on browser restart — re-load each session until the extension is signed.)

## Pair

1. Make sure `wabe start` is running with `bridge.enabled: true` in `config.yaml`.
2. Run `wabe bridge pair` — it prints the WebSocket URL and a 64-char hex token.
3. Open the extension popup, paste both, click "Save & connect".
4. The popup should switch to "connected".
5. `wabe bridge status` should report `connected on port 8431; extension last seen Ns ago`.

## First-run interaction (DataDome warm-up)

Before the first scan, visit `https://www.homegate.ch/rent` in the same browser, run a real search, and click into a listing. This lets DataDome's JS challenge complete and stamp its session cookies on `api.homegate.ch`. Without that warm-up the very first bridge call may still trip DataDome's fingerprint check.

Same for ImmoScout24: open `https://www.immoscout24.ch/` once before scanning.

## Caveats

- **Background context suspension.** Firefox event pages (and Chrome MV3 SWs) suspend after ~30 s idle. The WS drops; an `chrome.alarms` ping reconnects on next tick. **With DevTools open on the background script, Firefox keeps the page alive** — useful during testing. Robust always-on operation will eventually need an offscreen document (deferred).
- **Hidden tabs.** The extension opens one hidden tab per target host (visible in the tab strip; `active: false`). The page must reach `complete` before the bridge can dispatch.
- **No credentials on api.* fetches.** The api subdomains return `Access-Control-Allow-Origin: *`, which CORS forbids pairing with credentialed requests. We omit `credentials` and rely on DataDome's JS-injected request header for auth.
- **Single tenant.** Only one extension may be paired at a time per Wabe agent. A newer pairing preempts the older one server-side.
- **127.0.0.1 only.** The bridge is not reachable from other machines on the LAN.
- **Headless deployments.** Wabe falls back to its Playwright transport automatically when no extension is paired. The bridge is only useful where you'd otherwise be fighting DataDome from a server.
