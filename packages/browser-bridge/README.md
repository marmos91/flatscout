# @flatscout/browser-bridge

Server-side WebSocket bridge that lets a paired Flatscout browser extension proxy HTTPS requests from the user's real Chrome/Firefox session into the Flatscout agent.

The point of the bridge: source plugins that target DataDome/Cloudflare-protected hosts (Homegate, ImmoScout24) call `BrowserBridgeTransport.request(...)`; the request is forwarded to the connected extension, which runs `fetch()` inside a hidden tab loaded at the target's homepage via `chrome.scripting.executeScript({ world: 'MAIN' })`. The page's own DataDome-hooked `window.fetch` signs the request, so the upstream sees a legitimate web-app call. The response is shipped back over the WS.

## Daemon-only

`BrowserBridgeTransport.request()` dispatches through an in-process `getCurrentBridge()` singleton. That means **only the process running `flatscout start` can route requests through the bridge** — sibling commands (`flatscout scan --source homegate`) cannot, even when they see a fresh heartbeat file. Source plugins detect this and fall back to Playwright transparently.

## Components

- `protocol.ts` — Zod schemas for the wire format (`hello`, `welcome`, `reject`, `request`, `response`, `error`). Single `PROTOCOL_VERSION` constant; server + extension must agree.
- `secret.ts` — 32-byte random shared secret persisted at `${dataDir}/bridge-secret` (mode 0600). **First file in Flatscout to use this dataDir-secret pattern.** Constant-time validation via `crypto.timingSafeEqual`.
- `server.ts` — `startBridgeServer({ dataDir, port })` binds a `ws` `WebSocketServer` to `127.0.0.1` only (hard-coded; never `0.0.0.0`), exposes `dispatch(req)` to source plugins, tracks one connected extension at a time.
- `heartbeat.ts` — writes `${dataDir}/bridge.status.json` every ~5s so `flatscout bridge status` and `flatscout doctor` can read connection state without opening a second WS client.
- `transport.ts` — `Transport` interface + `BrowserBridgeTransport` adapter (same surface as `UndiciTransport` / `PlaywrightTransport` in source plugins).

## Used by

- `@flatscout/server` — starts the bridge when `top.bridge.enabled` is true.
- `@flatscout/cli` — `flatscout bridge pair` prints the pairing URL + token; `flatscout bridge status` reads the heartbeat file; `flatscout doctor` probes the same file.
- `@flatscout/source-homegate` — selects `BrowserBridgeTransport` first when the bridge is connected.
- `@flatscout/source-immoscout24` — paginates IS24 SRP HTML through the bridge and parses `window.__INITIAL_STATE__` for full-detail listings; optional PDP enrichment for contact channels.

## License

MIT.
