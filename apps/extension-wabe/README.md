# @wabe/extension-wabe

Manifest v3 WebExtension that pairs with a local Wabe agent. The extension's service worker holds a WebSocket to `@wabe/browser-bridge` (running inside `wabe start`). Wabe asks the extension to perform HTTPS requests on its behalf; the extension does so via the browser's native `fetch()` with the user's session cookies attached. This makes the requests indistinguishable from human browsing — the point being to bypass DataDome/Cloudflare anti-bot walls on Homegate and ImmoScout24.

## Build

```
pnpm install
pnpm --filter @wabe/extension-wabe build
```

Output: `apps/extension-wabe/dist/`.

By default the build targets Chrome (`background.service_worker`). Build for Firefox (which still ships MV3 with service workers disabled and requires `background.scripts`) by setting the env var:

```
WABE_EXT_BROWSER=firefox pnpm --filter @wabe/extension-wabe build
```

The two builds overwrite the same `dist/` — rebuild before loading into the other browser.

## Install (Chrome)

1. Visit `chrome://extensions`.
2. Toggle "Developer mode" on (top-right).
3. Click "Load unpacked" and pick `apps/extension-wabe/dist/`.

## Install (Firefox)

1. Visit `about:debugging` → "This Firefox" → "Load Temporary Add-on".
2. Pick `apps/extension-wabe/dist/manifest.json`.

(Firefox temporary add-ons unload on browser restart — re-load each session until the extension is signed.)

## Pair

1. Make sure `wabe start` is running with `bridge.enabled: true` in `config.yaml`.
2. Run `wabe bridge pair` — it prints the WebSocket URL and a 64-char hex token.
3. Open the extension popup, paste both, click "Save & connect".
4. The popup should switch to "connected".
5. `wabe bridge status` should now report `connected`.

## Caveats

- This is a manifest v3 service worker; the browser may suspend it after ~30s idle. A `chrome.alarms` ping every 30s keeps it warm.
- Only one extension may be paired at a time per Wabe agent. A newer pairing preempts the older one.
- The bridge binds to `127.0.0.1` only; it is not reachable from other machines on the LAN.
- Headless Wabe deployments (no GUI for the extension's browser) don't need this extension — Wabe falls back to its Playwright transport automatically.
