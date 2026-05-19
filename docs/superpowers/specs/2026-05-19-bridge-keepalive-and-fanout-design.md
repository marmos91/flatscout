# Browser Bridge — Always-On Keepalive + Cross-Process Fan-Out

**Status:** Draft
**Date:** 2026-05-19
**Supersedes (in part):** open follow-ups #1 and #2 of `docs/superpowers/plans/2026-05-18-phase-b-browser-bridge.md`

## Goal

Make the Wabe browser bridge usable in unattended, multi-process operation:

1. **Always-on Chrome keepalive** — the WebSocket between the daemon and the paired extension must survive without DevTools open. Today the MV3 service worker suspends after ~30s of idle, the socket dies, and we rely on the 30s alarm to reconnect. Unacceptable for unattended runs.
2. **Cross-process bridge access** — sibling CLI invocations (`wabe scan --source homegate`) must be able to dispatch through the daemon's paired extension instead of falling back to a path that no longer works.

Concurrently, accept that the Playwright fallback is dead for DataDome-protected sources (Homegate, ImmoScout24) and remove it.

## Non-goals

- Firefox-equivalent offscreen behavior. No public API exists; Firefox stays on the existing 30s reconnect loop. Documented limitation.
- Playwright-based automated extension tests (carried over follow-up).
- Chrome Web Store / AMO submission (carried over follow-up).
- Multiple paired extensions / multiple machines. One extension per daemon, single user, single machine.

## Architecture

Two independent changes share one design doc because they share the bridge surface and ship together.

```
┌────────────── machine ──────────────────────────────────────┐
│                                                             │
│   wabe start (daemon)              wabe scan --source X     │
│   ┌────────────────┐               ┌────────────────────┐   │
│   │ bridge server  │◀──/dispatch───│ DaemonBridge       │   │
│   │  /bridge ──────┼──┐            │  Transport         │   │
│   │  /dispatch ────┼──┼─?          └────────────────────┘   │
│   └────────────────┘  │                                     │
│                       ▼ WS                                  │
│   ┌──────────────────────────────────────────┐              │
│   │ Chrome extension (single instance)       │              │
│   │  offscreen.html  ◀── WS ──────           │              │
│   │     │ runtime.sendMessage(request)       │              │
│   │     ▼                                    │              │
│   │  background.ts (SW, woken per request)   │              │
│   │     │ chrome.scripting.executeScript     │              │
│   │     ▼                                    │              │
│   │  hidden tab @ www.homegate.ch (MAIN)     │              │
│   └──────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

Trust model unchanged: 127.0.0.1, shared `bridge.secret` (64 hex), both paths require valid token.

## Component 1 — Chrome offscreen document

### Why

`chrome.offscreen` (Chrome 109+) creates a hidden DOM document that does not suspend. Moving the WebSocket there decouples its lifetime from the service worker. The SW only wakes per-request via `chrome.runtime.sendMessage`, runs `chrome.scripting.executeScript`, and idles again — its designed wake path.

Rejected alternatives:

- *Offscreen ping-keepalive of the SW.* Works today but Google has signaled it may be cracked down on; less robust than moving the socket entirely.
- *Hidden tab keepalive.* Cross-browser, but user-visible in some configs and tab can be closed.

### Manifest changes

Chrome `manifest.json` (Firefox build script omits `"offscreen"`):

```json
{
  "permissions": ["storage", "cookies", "alarms", "declarativeNetRequest", "tabs", "scripting", "offscreen"]
}
```

### offscreen.ts (new)

Responsibilities:

- Read `bridgeUrl` + `authToken` from `chrome.storage.local`.
- Open WebSocket; send `hello`; handle `welcome` / `reject` exactly as today's `background.ts` does.
- On `request` from server: `chrome.runtime.sendMessage({ type: 'wabe-bridge:proxy', payload: msg })` to SW, await reply, send `response` or `error` on WS.
- Reconnect loop (1s → 30s exponential, same as today).
- Listen for `wabe-bridge:reconnect` messages (popup-triggered, forwarded by SW) and reset the socket.

### offscreen.html (new)

Empty document that loads `offscreen.ts`. No UI; never user-visible.

### background.ts (Chrome path, shrunk)

Responsibilities:

- On `onInstalled` / `onStartup`: ensure offscreen exists via `chrome.offscreen.hasDocument()` then `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'persistent WebSocket to local Wabe agent' })`. Idempotent.
- `chrome.runtime.onMessage` listener for `wabe-bridge:proxy`: run `ensureTabForOrigin` and `chrome.scripting.executeScript({world:'MAIN'})`, return `InPageFetchResult` via `sendResponse`.
- Forward `wabe-bridge:reconnect` from popup to offscreen via `chrome.runtime.sendMessage`.
- No WS code. No keepalive alarm.

### background.ts (Firefox path)

Unchanged. Feature-detect at the top of `background.ts`:

```ts
const HAS_OFFSCREEN = typeof chrome.offscreen !== 'undefined';
if (HAS_OFFSCREEN) {
  // chrome path: ensure offscreen, install onMessage handler for proxy + reconnect-forward
} else {
  // firefox path: existing WS + alarm code
}
```

Single source file, two execution paths. Tradeoff: ~30 lines of unused code in each dist. Acceptable; cheaper than two source files diverging.

### Reasons / justification text

`reasons: ['WORKERS']`. Closest official semantic for "long-lived background work." `LIFECYCLE` is undocumented; avoid.

## Component 2 — Daemon WebSocket fan-out

### Why

Today `BrowserBridgeTransport` calls `getCurrentBridge()` (in-process singleton). Sibling CLI processes have no in-process bridge; the singleton returns `null`; the transport selector falls through. Pre-this-spec it falls to Playwright, which is broken. Post-this-spec there is no fallback and the run errors.

Solution: the daemon's bridge server accepts a second WS path `/dispatch` for requester clients (sibling processes). Requesters speak the *same* protocol the server speaks to the extension: send `BridgeRequest`, await `BridgeResponse` / `BridgeError`.

### Protocol additions (`packages/browser-bridge/src/protocol.ts`)

Existing `ClientHello` already covers the handshake. Reused as-is.

New message direction: requester → server can send `BridgeRequest`. Server → requester can send `BridgeResponse` / `BridgeError`. Symmetric to the existing server-to-extension flow. No new message types.

### Server changes (`packages/browser-bridge/src/server.ts`)

- WS server matches `req.url`:
  - `/bridge` → extension client (existing path; preserved).
  - `/dispatch` → requester client.
- Both paths require the same token via existing `validateToken`.
- Replace single `activeSocket: WebSocket | null` with `{ extension: WebSocket | null; requesters: Set<WebSocket> }`.
- `inflight` becomes `Map<id, { resolve, reject, timer, origin: WebSocket | 'in-process' }>`. `origin` tells the response handler where to deliver:
  - `'in-process'` → resolve the in-process Promise as today (used by `dispatch(req)` calls from daemon's own plugins).
  - `WebSocket` → write `{ type: 'response', id, status, headers, body }` to that requester socket.
- Requester sends `request`: server records inflight with `origin = requester ws`, forwards `request` to extension WS (or replies error if extension offline).
- Extension replies `response` / `error`: server looks up inflight, routes to recorded origin.
- Requester WS closes mid-flight: server walks inflight, rejects entries owned by that WS, clears timers.
- Extension absent when a requester sends `request`: server replies `{ type: 'error', id, message: 'bridge not connected (extension offline?)' }` on requester WS. Requester transport surfaces as `Error` to caller. No buffering.

### Requester transport (`packages/browser-bridge/src/daemon-transport.ts`, new)

```ts
export class DaemonBridgeTransport implements Transport {
  static async tryConnect(dataDir: string): Promise<DaemonBridgeTransport | null>;
  request(opts: TransportRequestInit): Promise<TransportResponse>;
  close(): Promise<void>;
}
```

`tryConnect`:

1. Read `${dataDir}/bridge.status.json`. If missing → return null. If `age_ms > 15_000` (stale) → null. If `connected:false` → null.
2. Read `${dataDir}/bridge.secret`. If missing → null.
3. Open WS to `ws://127.0.0.1:${port}/dispatch`. Send `{ type:'hello', protocol_version, extension_version: 'cli', auth_token_hex: <hex> }` (the `extension_version` field is descriptive only; server doesn't gate on it). Await `welcome` within 5s; on timeout or `reject` → null.
4. On success → return live transport.

`request`:

- If socket not open → reject with `Error('daemon bridge socket closed')`.
- Generate request id; record local inflight map; send `BridgeRequest` over WS.
- Resolve on incoming `response` for that id; reject on `error`; reject on socket close (drains all pending) or `timeout_ms` timer.

`close`:

- Reject all pending inflight; close WS.

No auto-reconnect. The caller (transport selector) made a decision at init; if it dies, the run fails. This matches the "one WS open at start, close at end" approach chosen during brainstorming.

### Concurrency

Multiple requesters multiplex onto a single extension via the existing inflight `Map` (keyed by random UUID — no collision risk). The extension already runs `chrome.scripting.executeScript` per request without serializing across calls. FIFO. No fairness logic; `wabe scan` runs are short-lived.

### Trust

Same machine, same user. Anyone able to read `${dataDir}/bridge.secret` is already the user. Server distinguishes role by URL path, not token. Single trust boundary.

## Component 3 — Source plugin integration + Playwright cleanup

### Transport selector

Both `source-homegate` and `source-immoscout24-sitemap` adopt:

```ts
async function pickTransport(dataDir: string): Promise<Transport> {
  const local = getCurrentBridge();
  if (local) return new BrowserBridgeTransport(local);

  const daemon = await DaemonBridgeTransport.tryConnect(dataDir);
  if (daemon) return daemon;

  throw new Error(
    'source-homegate requires the Wabe browser bridge. ' +
      'Start `wabe start` with the extension paired, or run `wabe bridge pair` to set it up.'
  );
}
```

No silent fallback. The error message names the next step.

### Plugin teardown

Source plugin interface gains an optional `async dispose()` hook. `DaemonBridgeTransport`-using plugins call `transport.close()` from `dispose`. Pipeline shutdown invokes plugin disposers (existing shutdown chain — extend with the new hook).

### Playwright removal

- Delete `PlaywrightTransport` from `plugins/source-homegate/src/transport.ts`.
- Drop `playwright` dep from `plugins/source-homegate/package.json` and `plugins/source-immoscout24-sitemap/package.json` (if present).
- Drop any `pnpm postinstall` browser-download tooling or vitest skips that exist for Playwright.
- Update plugin READMEs: declare `requires: 'bridge'`.
- `wabe doctor`: when these sources are configured, hard-fail if bridge unpaired or extension offline.

## File map

### New files

| Path | Purpose |
|------|---------|
| `apps/extension-wabe/src/offscreen.ts` | WS client moved out of SW (Chrome dist) |
| `apps/extension-wabe/src/offscreen.html` | Empty doc that hosts offscreen.ts |
| `packages/browser-bridge/src/daemon-transport.ts` | `DaemonBridgeTransport` for sibling CLI processes |
| `packages/browser-bridge/test/fanout.test.ts` | In-process server + mock extension + N requesters |

### Modified files

| Path | Change |
|------|--------|
| `apps/extension-wabe/manifest.json` | + `"offscreen"` permission (Chrome dist only — build script split) |
| `apps/extension-wabe/src/background.ts` | Feature-detect offscreen; Chrome path shrinks to spawn + executeScript-only |
| `apps/extension-wabe/vite.config.ts` | Add offscreen entry, Chrome-only |
| `apps/extension-wabe/README.md` | Document Chrome offscreen behavior + Firefox limitation |
| `packages/browser-bridge/src/server.ts` | Two paths `/bridge` + `/dispatch`; requester set; origin-tagged inflight |
| `packages/browser-bridge/src/index.ts` | Export `DaemonBridgeTransport` |
| `plugins/source-homegate/src/index.ts` | New transport selector; hard error when no bridge |
| `plugins/source-homegate/src/transport.ts` | Delete `PlaywrightTransport` |
| `plugins/source-homegate/package.json` | Drop `playwright` dep |
| `plugins/source-homegate/README.md` | Declare `requires: 'bridge'` |
| `plugins/source-immoscout24-sitemap/src/index.ts` | Same selector + hard error |
| `plugins/source-immoscout24-sitemap/src/transport.ts` (if present) | Same Playwright removal |
| `plugins/source-immoscout24-sitemap/package.json` | Drop `playwright` dep |
| `plugins/source-immoscout24-sitemap/README.md` | Declare `requires: 'bridge'` |
| `packages/cli/src/commands/doctor.ts` | When DataDome sources configured, require bridge paired + connected |
| `CLAUDE.md` | Drop "daemon-only" wording; document daemon WS fan-out + Chrome offscreen keepalive |
| `docs/research/2026-05-18-homegate-investigation.md` | Append addendum: Playwright dropped for DataDome sources |

## Failure modes

| Scenario | Outcome |
|----------|---------|
| Daemon not running | `tryConnect` returns null → plugin init throws → `wabe scan` exits with clear error pointing at `wabe start` / `wabe bridge pair`. |
| Daemon up, extension never paired | `bridge.status.json` reports `connected:false` → `tryConnect` returns null → same hard error as above. |
| Daemon up, extension transient disconnect after `tryConnect` | Server rejects each `request` with `error` → plugin's request rejects → scheduler / circuit breaker handles. |
| Daemon WS dies mid-`wabe scan` | All subsequent requests reject → plugin's circuit breaker trips → scan exits non-zero. |
| Chrome offscreen evicted (Chrome low-memory reclaim, rare) | `onInstalled` / `onStartup` do not re-fire on offscreen eviction alone, so SW must self-heal. Every `onMessage` handler invocation calls `chrome.offscreen.hasDocument()` first and recreates if missing. New offscreen re-runs its WS connect loop and re-pairs on next handshake. In-flight requests at the moment of eviction fail with `error`; caller retries. |
| Firefox SW suspends | Existing reconnect-loop path; unchanged. |
| Two daemons started simultaneously (port clash) | Second fails to bind on `127.0.0.1:8431`; existing error path. |

## Testing

- `packages/browser-bridge/test/fanout.test.ts` — in-process WS server; mock "extension" connects on `/bridge` and echoes canned responses; 3 concurrent requesters open on `/dispatch` and assert (a) each sees its own response, (b) ids do not cross, (c) requester close mid-flight rejects only that requester's inflight, (d) extension absent → requester gets `error` reply.
- Daemon fan-out integration in `packages/server` — extend existing in-process pipeline test with a second worker that uses `DaemonBridgeTransport` against the same in-process bridge. Verify both paths share the mock extension cleanly. (Real subprocess test deferred.)
- Offscreen path: vitest cannot host MV3 context. Manual smoke test required (already the rule for extension changes). Add a checklist to `apps/extension-wabe/README.md`:
  - Load unpacked Chrome dist; pair via popup; close DevTools.
  - `wabe start` daemon.
  - Wait 5 minutes (well past SW idle timeout).
  - `wabe doctor` reports bridge connected.
  - Trigger a scan; new listings persisted.
  - Repeat after suspending Mac / closing lid for 10 minutes.
- Cross-process smoke: with daemon running, `wabe scan --source homegate` succeeds and persists listings.

## Sequencing

Two streams; each independently shippable but the spec ships them together:

1. **Stream A — Daemon fan-out.** Server, `DaemonBridgeTransport`, transport selector update, Playwright removal, fanout.test.ts. Smallest blast radius; no manifest changes.
2. **Stream B — Chrome offscreen.** Manifest + offscreen files + background.ts shrink + vite config + README. Requires manual smoke test before claiming complete.

Order: A first (fully testable in vitest), B second (gated on manual smoke).

## Migration / rollout

Both changes are local to the user's machine. No data migration. After install:

- Existing users: re-install extension (manifest changed). Pair flow unchanged.
- Existing `bridge.status.json` and `bridge.secret` are forward-compatible — no schema changes.
- First-time bridge setup unchanged: `wabe bridge pair` → load unpacked extension → paste URL + token.

## Open questions

None remaining at design time. Decisions during brainstorming:

- Offscreen scope: Chrome-only. Firefox stays on reconnect loop.
- Offscreen pattern: WS in offscreen, SW relays per-request (A in brainstorming Q2).
- Cross-process IPC: WS fan-out, not Unix socket (A in Q3).
- Auth: reuse `bridge.secret`, no separate requester token (A in Q4).
- Lifetime: persistent requester WS for `wabe scan` duration (C in Q5).
- Playwright cleanup: drop entirely from DataDome-source selector (i in followup Q).
