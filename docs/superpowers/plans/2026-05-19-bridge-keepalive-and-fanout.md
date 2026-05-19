# Bridge Keepalive + Cross-Process Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Wabe browser bridge usable in unattended, multi-process operation (Chrome offscreen keepalive + sibling-CLI fan-out via daemon WebSocket) and remove the broken Playwright fallback for DataDome-protected sources. Also folds in 7 fixes from PR #1 Copilot review.

**Architecture:** Two streams in one plan. Stream A: extend `@wabe/browser-bridge` server with a `/dispatch` path for requester clients; add `DaemonBridgeTransport` that sibling processes use after reading the heartbeat file. Stream B: move the extension's WebSocket out of the MV3 service worker and into a Chrome offscreen document so it never suspends; SW shrinks to a per-request `executeScript` handler. Firefox keeps the existing SW + alarm path.

**Tech Stack:** TypeScript, `ws` (Node WebSocket server), native `WebSocket` (offscreen + Node `ws` client), Vitest, vite-plugin-web-extension, MV3 `chrome.offscreen` API.

**Spec:** `docs/superpowers/specs/2026-05-19-bridge-keepalive-and-fanout-design.md`

**Sequencing:** Phase 1 (drive-by fixes) → Phase 2 (AbortSignal plumbing) → Phase 3 (Stream A: daemon fan-out) → Phase 4 (Stream B: Chrome offscreen + liveness). Phase 3 is fully vitest-testable. Phase 4 requires manual browser smoke before claiming complete.

---

## File map

### New files

| Path | Purpose |
|------|---------|
| `packages/browser-bridge/src/daemon-transport.ts` | `DaemonBridgeTransport` — WS client to daemon `/dispatch` |
| `packages/browser-bridge/test/fanout.test.ts` | Two-path server + N requesters integration test |
| `packages/browser-bridge/test/abort.test.ts` | `AbortSignal` propagation across server + transports |
| `apps/extension-wabe/src/offscreen.ts` | Long-lived WS client (Chrome only) |
| `apps/extension-wabe/src/offscreen.html` | Empty document hosting `offscreen.ts` |

### Modified files

| Path | Change |
|------|--------|
| `packages/browser-bridge/src/server.ts` | Drop `host` from `StartOpts`; add `/dispatch` path; origin-tagged inflight; `dispatch(req, opts?)` with `AbortSignal` |
| `packages/browser-bridge/src/transport.ts` | `BrowserBridgeTransport.request()` propagates `opts.signal` mid-flight |
| `packages/browser-bridge/src/index.ts` | Export `DaemonBridgeTransport` |
| `plugins/source-homegate/src/transport.ts` | Delete `PlaywrightTransport`; rewrite `selectTransport` to bridge-only with daemon fallback |
| `plugins/source-homegate/src/index.ts` | `dispose()` hook; await transport selection (now async) |
| `plugins/source-homegate/package.json` | Drop `@wabe/browser-runtime` Playwright dep if no longer needed (keep if still used by bootstrap; assess in task) |
| `plugins/source-homegate/test/transport.test.ts` | Update for new selector + drop Playwright tests |
| `plugins/source-homegate/README.md` | Declare `requires: 'bridge'` |
| `plugins/source-immoscout24-sitemap/src/index.ts` | Same selector pattern + dispose |
| `plugins/source-immoscout24-sitemap/README.md` | Declare `requires: 'bridge'` |
| `packages/plugin-sdk/src/index.ts` (or wherever `Source` lives) | Add optional `dispose?(): Promise<void>` to `Source` |
| `packages/server/src/pipeline.ts` | Call `plugin.dispose?.()` on shutdown if defined |
| `packages/cli/src/commands/doctor.ts` | Hard-fail when DataDome sources configured and bridge unpaired/offline |
| `apps/extension-wabe/manifest.json` | Add `"offscreen"` permission; widen `connect-src`; drop invalid `ws://` / `http://` host_permissions |
| `apps/extension-wabe/src/background.ts` | Chrome: shrink to spawn-offscreen + proxy handler; Firefox: `KEEPALIVE_MIN=1` + `lastAliveAt` on alarm |
| `apps/extension-wabe/src/popup.ts` | Use `lastAliveAt`; widen `STALE_AFTER_MS=90_000` |
| `apps/extension-wabe/src/dnr-rules.json` | Narrow rule #2 to `||api.immoscout24.ch/` + `resourceTypes: ["xmlhttprequest"]` |
| `apps/extension-wabe/vite.config.ts` | Register `src/offscreen.html` as additional input |
| `apps/extension-wabe/README.md` | Manual smoke-test checklist for Chrome offscreen + Firefox limitation |
| `CLAUDE.md` | Drop "daemon-only" wording for bridge |
| `docs/research/2026-05-18-homegate-investigation.md` | Append addendum on Playwright drop |

---

## Phase 1 — Drive-by fixes (independent, low risk)

### Task 1: Hard-enforce loopback in `StartOpts`

**Files:**
- Modify: `packages/browser-bridge/src/server.ts`
- Test: `packages/browser-bridge/test/server.test.ts` (existing)

- [ ] **Step 1: Add failing test**

Append to `packages/browser-bridge/test/server.test.ts`:

```ts
describe('startBridgeServer loopback enforcement', () => {
  it('always binds 127.0.0.1 even when StartOpts has no host field', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wabe-bridge-loopback-'));
    const b = await startBridgeServer({ dataDir: tmp, port: 0 });
    // ws.address() can return string|object; we only care that the active
    // server is reachable at 127.0.0.1.
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/bridge`);
    await new Promise<void>((r, reject) => {
      ws.once('open', () => r());
      ws.once('error', reject);
    });
    ws.close();
    await b.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects a host field at the type level (compile-time guard)', () => {
    // Type-only assertion; ensures `host` is no longer accepted.
    type Opts = Parameters<typeof startBridgeServer>[0];
    type HasHost = 'host' extends keyof Opts ? true : false;
    const _proof: HasHost = false;
    expect(_proof).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify the type-check fails**

Run: `pnpm --filter @wabe/browser-bridge test -- server.test.ts`

Expected: type error or runtime failure depending on whether `host` was passed elsewhere.

- [ ] **Step 3: Remove `host` from `StartOpts`**

Edit `packages/browser-bridge/src/server.ts`:

```ts
export interface StartOpts {
  dataDir: string;
  /** Pass 0 to let the OS pick a free port (used in tests). */
  port: number;
}
```

And in `startBridgeServer`:

```ts
export async function startBridgeServer(opts: StartOpts): Promise<BridgeServer> {
  const secret = loadOrGenerateSecret(opts.dataDir);
  const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port, path: '/bridge' });
  // ... rest unchanged
}
```

- [ ] **Step 4: Update any callers passing `host`**

Run: `grep -rn "startBridgeServer" packages/ plugins/ apps/`

Remove `host:` keys from any caller. Expected hit: `packages/server/src/index.ts` and possibly tests. Strip them.

- [ ] **Step 5: Run all tests in the package**

Run: `pnpm --filter @wabe/browser-bridge test`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/server.test.ts packages/server/src/index.ts
git commit -S -m "fix(browser-bridge): hard-enforce loopback bind; drop StartOpts.host"
```

---

### Task 2: Narrow DNR rule #2 to API host + xhr only

**Files:**
- Modify: `apps/extension-wabe/src/dnr-rules.json`

- [ ] **Step 1: Replace rule #2**

Set the whole file to:

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": {
      "type": "modifyHeaders",
      "requestHeaders": [
        { "header": "origin", "operation": "set", "value": "https://www.homegate.ch" },
        { "header": "referer", "operation": "set", "value": "https://www.homegate.ch/rent" }
      ]
    },
    "condition": {
      "urlFilter": "||api.homegate.ch/",
      "resourceTypes": ["xmlhttprequest"]
    }
  },
  {
    "id": 2,
    "priority": 1,
    "action": {
      "type": "modifyHeaders",
      "requestHeaders": [
        { "header": "origin", "operation": "set", "value": "https://www.immoscout24.ch" },
        { "header": "referer", "operation": "set", "value": "https://www.immoscout24.ch/" }
      ]
    },
    "condition": {
      "urlFilter": "||api.immoscout24.ch/",
      "resourceTypes": ["xmlhttprequest"]
    }
  }
]
```

- [ ] **Step 2: Re-run extension build to validate**

Run: `pnpm --filter wabe-extension build`

Expected: build succeeds; `dist/chrome/src/dnr-rules.json` and `dist/firefox/src/dnr-rules.json` contain the new content.

- [ ] **Step 3: Commit**

```bash
git add apps/extension-wabe/src/dnr-rules.json
git commit -S -m "fix(extension): narrow immoscout24 DNR rule to api host + xhr"
```

---

### Task 3: Manifest CSP widening + drop invalid host_permissions

**Files:**
- Modify: `apps/extension-wabe/manifest.json`

- [ ] **Step 1: Edit manifest**

Apply this exact change in `manifest.json`:

Replace:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:8431 ws://localhost:8431 https: wss:"
},
"host_permissions": [
  "*://*.homegate.ch/*",
  "*://api.homegate.ch/*",
  "*://*.immoscout24.ch/*",
  "*://api.immoscout24.ch/*",
  "ws://127.0.0.1/*",
  "http://127.0.0.1/*"
],
```

With:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:* https: wss:"
},
"host_permissions": [
  "*://*.homegate.ch/*",
  "*://api.homegate.ch/*",
  "*://*.immoscout24.ch/*",
  "*://api.immoscout24.ch/*"
],
```

- [ ] **Step 2: Build and lint manifest**

Run: `pnpm --filter wabe-extension build`

Expected: no manifest validation errors from `vite-plugin-web-extension`. Both `dist/chrome/manifest.json` and `dist/firefox/manifest.json` reflect the new shape.

- [ ] **Step 3: Commit**

```bash
git add apps/extension-wabe/manifest.json
git commit -S -m "fix(extension): widen connect-src to any local port; drop invalid ws/http host_permissions"
```

---

## Phase 2 — AbortSignal plumbing

### Task 4: `BridgeServer.dispatch` accepts `AbortSignal`

**Files:**
- Modify: `packages/browser-bridge/src/server.ts`
- Test: `packages/browser-bridge/test/abort.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `packages/browser-bridge/test/abort.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '../src/secret.js';
import { startBridgeServer, type BridgeServer, newRequestId } from '../src/server.js';

let dir: string;
let bridge: BridgeServer;
let port: number;
let secret: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-abort-'));
  secret = loadOrGenerateSecret(dir);
  bridge = await startBridgeServer({ dataDir: dir, port: 0 });
  port = bridge.port;
});

afterEach(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function pairMockExtension(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await new Promise<void>((r, reject) => {
    ws.once('open', () => r());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: 1,
      extension_version: 'test',
      auth_token_hex: secret,
    }),
  );
  // wait for welcome
  await new Promise<void>((r) => ws.once('message', () => r()));
  return ws;
}

describe('BridgeServer.dispatch AbortSignal', () => {
  it('rejects immediately when signal is already aborted', async () => {
    await pairMockExtension();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      bridge.dispatch(
        {
          type: 'request',
          id: newRequestId(),
          method: 'GET',
          url: 'https://www.homegate.ch/',
          headers: {},
          timeout_ms: 30_000,
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(/abort/i);
  });

  it('rejects when signal aborts mid-flight; ignores late extension response', async () => {
    const ext = await pairMockExtension();
    const ctrl = new AbortController();
    const reqId = newRequestId();
    const p = bridge.dispatch(
      {
        type: 'request',
        id: reqId,
        method: 'GET',
        url: 'https://www.homegate.ch/',
        headers: {},
        timeout_ms: 30_000,
      },
      { signal: ctrl.signal },
    );
    // Wait briefly so extension actually receives the request frame.
    await new Promise<void>((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
    // Late response must NOT throw or resurrect the promise.
    ext.send(
      JSON.stringify({ type: 'response', id: reqId, status: 200, headers: {}, body: '{}' }),
    );
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(bridge.status().inflight).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/browser-bridge test -- abort.test.ts`

Expected: FAIL — `dispatch` either ignores `signal` or doesn't accept the second argument.

- [ ] **Step 3: Update `dispatch` signature + body**

In `packages/browser-bridge/src/server.ts`, change the `BridgeServer` interface:

```ts
export interface BridgeServer {
  port: number;
  status(): BridgeStatus;
  dispatch(req: BridgeRequest, opts?: { signal?: AbortSignal }): Promise<BridgeResponse>;
  stop(): Promise<void>;
}
```

Update the `dispatch` implementation inside `startBridgeServer`:

```ts
function dispatch(
  req: BridgeRequest,
  opts?: { signal?: AbortSignal },
): Promise<BridgeResponse> {
  const signal = opts?.signal;
  if (signal?.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  const sock = activeSocket;
  if (!sock || sock.readyState !== sock.OPEN) {
    return Promise.reject(new Error('bridge not connected (extension offline?)'));
  }
  return new Promise<BridgeResponse>((resolve, reject) => {
    const onAbort = (): void => {
      const ifl = inflight.get(req.id);
      if (!ifl) return;
      clearTimeout(ifl.timer);
      inflight.delete(req.id);
      ifl.reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      inflight.delete(req.id);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`bridge request ${req.id} timed out after ${req.timeout_ms}ms`));
    }, req.timeout_ms);
    inflight.set(req.id, {
      resolve: (r) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      },
      reject: (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
      timer,
    });
    sock.send(JSON.stringify(req));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wabe/browser-bridge test -- abort.test.ts`

Expected: PASS. All tests in the package green.

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/abort.test.ts
git commit -S -m "feat(browser-bridge): dispatch accepts AbortSignal; drops inflight on abort"
```

---

### Task 5: `BrowserBridgeTransport.request` propagates signal mid-flight

**Files:**
- Modify: `packages/browser-bridge/src/transport.ts`
- Test: `packages/browser-bridge/test/abort.test.ts` (append)

- [ ] **Step 1: Append failing test**

Add to `packages/browser-bridge/test/abort.test.ts`:

```ts
import { BrowserBridgeTransport } from '../src/transport.js';

describe('BrowserBridgeTransport abort', () => {
  it('aborts after dispatch starts', async () => {
    await pairMockExtension();
    const t = new BrowserBridgeTransport(bridge);
    const ctrl = new AbortController();
    const p = t.request({
      method: 'GET',
      url: 'https://www.homegate.ch/',
      signal: ctrl.signal,
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/browser-bridge test -- abort.test.ts`

Expected: FAIL — `request()` never resolves on abort (waits for timeout).

- [ ] **Step 3: Update `request`**

In `packages/browser-bridge/src/transport.ts`:

```ts
async request(opts: TransportRequestInit): Promise<TransportResponse> {
  if (opts.signal?.aborted) {
    throw new Error('aborted');
  }
  const bridge = this.bridge ?? getCurrentBridge();
  if (!bridge) {
    throw new Error('no bridge server is running in this process');
  }
  const req: BridgeRequest = {
    type: 'request',
    id: newRequestId(),
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    body: opts.body,
    timeout_ms: opts.timeout_ms ?? 30_000,
  };
  const resp = await bridge.dispatch(req, { signal: opts.signal });
  return { status: resp.status, headers: resp.headers, body: resp.body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wabe/browser-bridge test`

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/transport.ts packages/browser-bridge/test/abort.test.ts
git commit -S -m "feat(browser-bridge): BrowserBridgeTransport propagates AbortSignal to dispatch"
```

---

## Phase 3 — Stream A: Daemon WebSocket fan-out

### Task 6: Server splits paths `/bridge` + `/dispatch`; role-tagged sockets

**Files:**
- Modify: `packages/browser-bridge/src/server.ts`
- Test: `packages/browser-bridge/test/fanout.test.ts` (new)

- [ ] **Step 1: Create failing fan-out test (handshake only)**

Create `packages/browser-bridge/test/fanout.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '../src/secret.js';
import { startBridgeServer, type BridgeServer } from '../src/server.js';

let dir: string;
let bridge: BridgeServer;
let port: number;
let secret: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-fanout-'));
  secret = loadOrGenerateSecret(dir);
  bridge = await startBridgeServer({ dataDir: dir, port: 0 });
  port = bridge.port;
});

afterEach(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function open(ws: WebSocket): Promise<void> {
  await new Promise<void>((r, reject) => {
    ws.once('open', () => r());
    ws.once('error', reject);
  });
}

async function helloOk(ws: WebSocket): Promise<void> {
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: 1,
      extension_version: 'test',
      auth_token_hex: secret,
    }),
  );
  await new Promise<void>((r) => ws.once('message', () => r()));
}

describe('two-path bridge server', () => {
  it('accepts a hello on /dispatch with the same secret as /bridge', async () => {
    const r = new WebSocket(`ws://127.0.0.1:${port}/dispatch`);
    await open(r);
    await helloOk(r);
    r.close();
  });

  it('rejects connections on unknown paths', async () => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/wat`);
    await expect(
      new Promise<void>((_resolve, reject) => {
        w.once('open', () => reject(new Error('should not have opened')));
        w.once('error', () => reject(new Error('error')));
        w.once('close', () => reject(new Error('closed')));
      }),
    ).rejects.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: FAIL — server today only listens at `/bridge`.

- [ ] **Step 3: Update server to accept both paths**

In `packages/browser-bridge/src/server.ts`:

Replace the `WebSocketServer` construction:

```ts
const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port, path: '/bridge' });
```

with a no-path, manual upgrade matcher:

```ts
const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port, handleProtocols: () => false });
```

Wait — easier path: use `noServer: true` and intercept `upgrade`. Replace the construction:

```ts
import { createServer } from 'node:http';
// ...
const http = createServer();
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url !== '/bridge' && url !== '/dispatch') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as WebSocket & { _path?: string })._path = url;
    wss.emit('connection', ws, req);
  });
});
await new Promise<void>((resolve, reject) => {
  http.once('listening', () => resolve());
  http.once('error', reject);
  http.listen(opts.port, '127.0.0.1');
});
const address = http.address();
const port = typeof address === 'object' && address ? address.port : 0;
```

In `wss.on('connection', (ws, req) => { ... })`, read role:

```ts
const role: 'extension' | 'requester' =
  (ws as WebSocket & { _path?: string })._path === '/dispatch' ? 'requester' : 'extension';
```

Stub the requester branch (full behavior in Task 7) — for now just accept the hello and stay open:

```ts
if (role === 'requester') {
  // Will be fully handled in Task 7. For now, accept the hello and idle.
  let helloReceived = false;
  ws.on('message', (raw) => {
    if (!helloReceived) {
      try {
        const parsed = JSON.parse(String(raw));
        const hello = ClientHello.safeParse(parsed);
        if (!hello.success || !validateToken(secret, hello.data.auth_token_hex)) {
          ws.send(JSON.stringify({ type: 'reject', reason: hello.success ? 'bad token' : 'bad hello' }));
          ws.close();
          return;
        }
        helloReceived = true;
        ws.send(JSON.stringify({ type: 'welcome', protocol_version: PROTOCOL_VERSION }));
      } catch {
        ws.close();
      }
    }
    // post-hello requester messages handled in Task 7
  });
  ws.on('close', () => {});
  return;
}
```

Also: `http.close()` in `stop()`:

```ts
async function stop(): Promise<void> {
  for (const ifl of inflight.values()) {
    clearTimeout(ifl.timer);
    ifl.reject(new Error('bridge server stopping'));
  }
  inflight.clear();
  if (activeSocket) {
    try { activeSocket.close(); } catch { /* ignore */ }
    activeSocket = null;
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
  if (currentBridge === handle) currentBridge = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: PASS for the handshake test; the existing `/bridge` tests still pass.

- [ ] **Step 5: Run full package tests**

Run: `pnpm --filter @wabe/browser-bridge test`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/fanout.test.ts
git commit -S -m "feat(browser-bridge): accept /dispatch path for requester clients"
```

---

### Task 7: Origin-tagged inflight; full fan-out routing

**Files:**
- Modify: `packages/browser-bridge/src/server.ts`
- Test: `packages/browser-bridge/test/fanout.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Append to `packages/browser-bridge/test/fanout.test.ts`:

```ts
import type { BridgeRequest, BridgeResponse } from '../src/protocol.js';

async function pairExtension(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await open(ws);
  await helloOk(ws);
  return ws;
}

async function pairRequester(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/dispatch`);
  await open(ws);
  await helloOk(ws);
  return ws;
}

function recvJson(ws: WebSocket, predicate: (m: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData): void => {
      const parsed = JSON.parse(String(data));
      if (predicate(parsed)) {
        ws.off('message', onMsg);
        resolve(parsed);
      }
    };
    ws.on('message', onMsg);
  });
}

describe('fan-out routing', () => {
  it('routes a requester request through the extension and back to that requester', async () => {
    const ext = await pairExtension();
    const req1 = await pairRequester();
    // Extension echoes whatever request id it receives.
    ext.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as Partial<BridgeRequest>;
      if (parsed.type !== 'request') return;
      ext.send(
        JSON.stringify({
          type: 'response',
          id: parsed.id,
          status: 200,
          headers: {},
          body: JSON.stringify({ ok: true, id: parsed.id }),
        }),
      );
    });
    const reqId = 'fan-1';
    req1.send(
      JSON.stringify({
        type: 'request',
        id: reqId,
        method: 'GET',
        url: 'https://www.homegate.ch/',
        headers: {},
        timeout_ms: 5_000,
      }),
    );
    const msg = (await recvJson(req1, (m) => (m as { id?: string }).id === reqId)) as BridgeResponse;
    expect(msg.type).toBe('response');
    expect(msg.status).toBe(200);
  });

  it('does not cross-deliver responses between two concurrent requesters', async () => {
    const ext = await pairExtension();
    const r1 = await pairRequester();
    const r2 = await pairRequester();
    ext.on('message', (raw) => {
      const p = JSON.parse(String(raw)) as Partial<BridgeRequest>;
      if (p.type !== 'request') return;
      // Delay slightly to interleave
      setTimeout(() => {
        ext.send(
          JSON.stringify({
            type: 'response',
            id: p.id,
            status: 200,
            headers: {},
            body: p.id ?? '',
          }),
        );
      }, 10);
    });
    const send = (ws: WebSocket, id: string): void => {
      ws.send(
        JSON.stringify({
          type: 'request',
          id,
          method: 'GET',
          url: 'https://www.homegate.ch/',
          headers: {},
          timeout_ms: 5_000,
        }),
      );
    };
    send(r1, 'A');
    send(r2, 'B');
    const [a, b] = await Promise.all([
      recvJson(r1, (m) => (m as { id?: string }).id === 'A') as Promise<BridgeResponse>,
      recvJson(r2, (m) => (m as { id?: string }).id === 'B') as Promise<BridgeResponse>,
    ]);
    expect(a.body).toBe('A');
    expect(b.body).toBe('B');
  });

  it('sends error reply to requester when no extension is paired', async () => {
    const r = await pairRequester();
    r.send(
      JSON.stringify({
        type: 'request',
        id: 'lonely',
        method: 'GET',
        url: 'https://www.homegate.ch/',
        headers: {},
        timeout_ms: 5_000,
      }),
    );
    const msg = (await recvJson(r, (m) => (m as { id?: string }).id === 'lonely')) as {
      type: string;
      message?: string;
    };
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/not connected/i);
  });

  it('drops inflight entries owned by a requester that disconnects mid-flight', async () => {
    const ext = await pairExtension();
    const r = await pairRequester();
    // Extension intentionally never responds.
    r.send(
      JSON.stringify({
        type: 'request',
        id: 'orphan',
        method: 'GET',
        url: 'https://www.homegate.ch/',
        headers: {},
        timeout_ms: 30_000,
      }),
    );
    await new Promise<void>((res) => setTimeout(res, 50));
    expect(bridge.status().inflight).toBe(1);
    r.close();
    await new Promise<void>((res) => setTimeout(res, 50));
    expect(bridge.status().inflight).toBe(0);
    // Late response should be silently dropped.
    ext.send(
      JSON.stringify({ type: 'response', id: 'orphan', status: 200, headers: {}, body: '' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: FAIL — requester message handling is stubbed.

- [ ] **Step 3: Implement origin-tagged inflight + routing**

In `packages/browser-bridge/src/server.ts`:

Replace the `Inflight` type:

```ts
type Origin = WebSocket | 'in-process';

interface Inflight {
  resolve: (r: BridgeResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  origin: Origin;
}
```

Add a `requesters: Set<WebSocket>` and update inflight insert sites to set `origin`. In-process `dispatch`:

```ts
inflight.set(req.id, {
  resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); },
  reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
  timer,
  origin: 'in-process',
});
```

Replace the requester stub block from Task 6 with the full handler:

```ts
if (role === 'requester') {
  let helloReceived = false;
  requesters.add(ws);
  ws.on('message', (raw) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw)); } catch {
      ws.close(); return;
    }
    if (!helloReceived) {
      const hello = ClientHello.safeParse(parsed);
      if (!hello.success) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'bad hello' })); ws.close(); return;
      }
      if (!validateToken(secret, hello.data.auth_token_hex)) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'bad token' })); ws.close(); return;
      }
      helloReceived = true;
      ws.send(JSON.stringify({ type: 'welcome', protocol_version: PROTOCOL_VERSION }));
      return;
    }
    const reqMsg = BridgeRequest.safeParse(parsed);
    if (!reqMsg.success) return;
    if (!activeSocket || activeSocket.readyState !== activeSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: 'error', id: reqMsg.data.id, message: 'bridge not connected (extension offline?)' }),
      );
      return;
    }
    const timer = setTimeout(() => {
      inflight.delete(reqMsg.data.id);
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            id: reqMsg.data.id,
            message: `bridge request ${reqMsg.data.id} timed out after ${reqMsg.data.timeout_ms}ms`,
          }),
        );
      } catch { /* ignore */ }
    }, reqMsg.data.timeout_ms);
    inflight.set(reqMsg.data.id, {
      resolve: (r) => {
        try { ws.send(JSON.stringify(r)); } catch { /* ignore */ }
      },
      reject: (e) => {
        try { ws.send(JSON.stringify({ type: 'error', id: reqMsg.data.id, message: e.message })); } catch { /* ignore */ }
      },
      timer,
      origin: ws,
    });
    activeSocket.send(JSON.stringify(reqMsg.data));
  });
  ws.on('close', () => {
    requesters.delete(ws);
    for (const [id, ifl] of inflight) {
      if (ifl.origin === ws) {
        clearTimeout(ifl.timer);
        inflight.delete(id);
      }
    }
  });
  return;
}
```

Update the extension's response/error handler so `resolve` / `reject` correctly invokes the recorded origin's resolve/reject (the `resolve` / `reject` functions on the inflight entry already route — no further change needed since requester-origin inflight resolves by `ws.send`).

Don't forget: add `BridgeRequest` to the imports in `server.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: PASS. All four fan-out tests + full package suite green.

- [ ] **Step 5: Run full package tests**

Run: `pnpm --filter @wabe/browser-bridge test`

- [ ] **Step 6: Commit**

```bash
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/fanout.test.ts
git commit -S -m "feat(browser-bridge): route requester requests through extension; drop orphaned inflight"
```

---

### Task 8: `DaemonBridgeTransport` skeleton (WS client + hello)

**Files:**
- Create: `packages/browser-bridge/src/daemon-transport.ts`
- Modify: `packages/browser-bridge/src/index.ts`
- Test: `packages/browser-bridge/test/fanout.test.ts` (append)

- [ ] **Step 1: Append failing test for transport**

Append to `packages/browser-bridge/test/fanout.test.ts`:

```ts
import { DaemonBridgeTransport } from '../src/daemon-transport.js';
import { writeFileSync } from 'node:fs';

describe('DaemonBridgeTransport', () => {
  it('connects on /dispatch and round-trips a request', async () => {
    const ext = await pairExtension();
    ext.on('message', (raw) => {
      const p = JSON.parse(String(raw)) as Partial<BridgeRequest>;
      if (p.type !== 'request') return;
      ext.send(
        JSON.stringify({ type: 'response', id: p.id, status: 200, headers: { x: 'y' }, body: 'hi' }),
      );
    });
    // Write a fresh heartbeat so tryConnect succeeds.
    const status = { connected: true, inflight: 0, port, last_seen_at: Date.now(), written_at: Date.now() };
    writeFileSync(join(dir, 'bridge.status.json'), JSON.stringify(status));
    const t = await DaemonBridgeTransport.tryConnect(dir);
    expect(t).not.toBeNull();
    const resp = await t!.request({
      method: 'GET',
      url: 'https://www.homegate.ch/',
    });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('hi');
    expect(resp.headers.x).toBe('y');
    await t!.close();
  });

  it('returns null when heartbeat file is missing', async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'wabe-bridge-noheart-'));
    const t = await DaemonBridgeTransport.tryConnect(tmp2);
    expect(t).toBeNull();
    rmSync(tmp2, { recursive: true, force: true });
  });

  it('returns null when heartbeat is stale', async () => {
    const status = {
      connected: true,
      inflight: 0,
      port,
      last_seen_at: 0,
      written_at: Date.now() - 30_000,
    };
    writeFileSync(join(dir, 'bridge.status.json'), JSON.stringify(status));
    const t = await DaemonBridgeTransport.tryConnect(dir);
    expect(t).toBeNull();
  });

  it('returns null when heartbeat reports connected:false', async () => {
    const status = {
      connected: false,
      inflight: 0,
      port,
      last_seen_at: 0,
      written_at: Date.now(),
    };
    writeFileSync(join(dir, 'bridge.status.json'), JSON.stringify(status));
    const t = await DaemonBridgeTransport.tryConnect(dir);
    expect(t).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `daemon-transport.ts`**

Create `packages/browser-bridge/src/daemon-transport.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type {
  BridgeError,
  BridgeRequest,
  BridgeResponse,
  ServerReject,
  ServerWelcome,
} from './protocol.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { readHeartbeat } from './heartbeat.js';
import type { Transport, TransportRequestInit, TransportResponse } from './transport.js';

const SECRET_FILE = 'bridge-secret';
const HEARTBEAT_MAX_AGE_MS = 15_000;
const WELCOME_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (r: TransportResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Requester-side client for a bridge daemon's `/dispatch` path. Created by a
 * sibling CLI process that wants to route HTTPS requests through the daemon's
 * paired browser extension.
 */
export class DaemonBridgeTransport implements Transport {
  private readonly inflight = new Map<string, PendingRequest>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', () => this.onSocketClose());
    ws.on('error', () => { /* close will follow */ });
  }

  static async tryConnect(dataDir: string): Promise<DaemonBridgeTransport | null> {
    const hb = readHeartbeat(dataDir);
    if (!hb) return null;
    if (hb.age_ms > HEARTBEAT_MAX_AGE_MS) return null;
    if (!hb.connected) return null;

    let secret: string;
    try {
      secret = readFileSync(join(dataDir, SECRET_FILE), 'utf8').trim();
    } catch {
      return null;
    }

    const ws = new WebSocket(`ws://127.0.0.1:${hb.port}/dispatch`);
    const opened = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), WELCOME_TIMEOUT_MS);
      ws.once('open', () => { clearTimeout(t); resolve(true); });
      ws.once('error', () => { clearTimeout(t); resolve(false); });
    });
    if (!opened) {
      try { ws.terminate(); } catch { /* ignore */ }
      return null;
    }

    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        extension_version: 'wabe-cli-requester',
        auth_token_hex: secret,
      }),
    );

    const welcome = await new Promise<ServerWelcome | ServerReject | null>((resolve) => {
      const t = setTimeout(() => resolve(null), WELCOME_TIMEOUT_MS);
      ws.once('message', (data) => {
        clearTimeout(t);
        try { resolve(JSON.parse(String(data))); } catch { resolve(null); }
      });
    });
    if (!welcome || welcome.type !== 'welcome') {
      try { ws.close(); } catch { /* ignore */ }
      return null;
    }

    return new DaemonBridgeTransport(ws);
  }

  private onMessage(raw: WebSocket.RawData): void {
    let parsed: BridgeResponse | BridgeError;
    try { parsed = JSON.parse(String(raw)); } catch { return; }
    const ifl = this.inflight.get(parsed.id);
    if (!ifl) return;
    clearTimeout(ifl.timer);
    if (ifl.signal && ifl.onAbort) ifl.signal.removeEventListener('abort', ifl.onAbort);
    this.inflight.delete(parsed.id);
    if (parsed.type === 'response') {
      ifl.resolve({ status: parsed.status, headers: parsed.headers, body: parsed.body });
    } else {
      ifl.reject(new Error(parsed.message));
    }
  }

  private onSocketClose(): void {
    this.closed = true;
    for (const [, ifl] of this.inflight) {
      clearTimeout(ifl.timer);
      if (ifl.signal && ifl.onAbort) ifl.signal.removeEventListener('abort', ifl.onAbort);
      ifl.reject(new Error('daemon bridge socket closed'));
    }
    this.inflight.clear();
  }

  async request(opts: TransportRequestInit): Promise<TransportResponse> {
    if (this.closed) throw new Error('daemon bridge socket closed');
    if (opts.signal?.aborted) throw new Error('aborted');
    const id = randomUUID();
    const timeout_ms = opts.timeout_ms ?? 30_000;
    const req: BridgeRequest = {
      type: 'request',
      id,
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      body: opts.body,
      timeout_ms,
    };
    return new Promise<TransportResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const ifl = this.inflight.get(id);
        if (!ifl) return;
        clearTimeout(ifl.timer);
        this.inflight.delete(id);
        reject(new Error('aborted'));
      };
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        reject(new Error(`daemon bridge request ${id} timed out after ${timeout_ms}ms`));
      }, timeout_ms);
      this.inflight.set(id, { resolve, reject, timer, onAbort, signal: opts.signal });
      try {
        this.ws.send(JSON.stringify(req));
      } catch (err) {
        this.inflight.delete(id);
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, ifl] of this.inflight) {
      clearTimeout(ifl.timer);
      ifl.reject(new Error('daemon bridge transport closed by caller'));
    }
    this.inflight.clear();
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
```

Export it in `packages/browser-bridge/src/index.ts`:

```ts
export { DaemonBridgeTransport } from './daemon-transport.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wabe/browser-bridge test -- fanout.test.ts`

Expected: PASS — all four DaemonBridgeTransport tests green.

- [ ] **Step 5: Append abort propagation test for DaemonBridgeTransport**

Append to `packages/browser-bridge/test/abort.test.ts`:

```ts
import { DaemonBridgeTransport } from '../src/daemon-transport.js';
import { writeFileSync } from 'node:fs';

describe('DaemonBridgeTransport abort', () => {
  it('aborts after dispatch starts', async () => {
    await pairMockExtension();
    const hb = { connected: true, inflight: 0, port, last_seen_at: Date.now(), written_at: Date.now() };
    writeFileSync(join(dir, 'bridge.status.json'), JSON.stringify(hb));
    const t = await DaemonBridgeTransport.tryConnect(dir);
    expect(t).not.toBeNull();
    const ctrl = new AbortController();
    const p = t!.request({
      method: 'GET',
      url: 'https://www.homegate.ch/',
      signal: ctrl.signal,
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
    await t!.close();
  });
});
```

- [ ] **Step 6: Run abort suite**

Run: `pnpm --filter @wabe/browser-bridge test -- abort.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/browser-bridge/src/daemon-transport.ts packages/browser-bridge/src/index.ts packages/browser-bridge/test/fanout.test.ts packages/browser-bridge/test/abort.test.ts
git commit -S -m "feat(browser-bridge): DaemonBridgeTransport for cross-process bridge access"
```

---

### Task 9: Source plugin transport selector — homegate

**Files:**
- Modify: `plugins/source-homegate/src/transport.ts`
- Modify: `plugins/source-homegate/src/index.ts`
- Modify: `plugins/source-homegate/test/transport.test.ts`
- Modify: `plugins/source-homegate/README.md`
- Modify: `plugins/source-homegate/package.json`

- [ ] **Step 1: Rewrite transport selector in `plugins/source-homegate/src/transport.ts`**

Drop the `PlaywrightTransport` class and `UndiciTransport`. Keep `HomegateBridgeTransport` but accept an underlying `Transport` in its constructor:

```ts
import type { Logger } from 'pino';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type Transport as BridgeTransport,
} from '@wabe/browser-bridge';

export type TransportKind = 'bridge-inproc' | 'bridge-daemon';

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE';
  url: string;
  hasBody: boolean;
  body?: string;
  signal: AbortSignal;
  logger: Logger;
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

export interface Transport {
  readonly kind: TransportKind;
  request(opts: TransportRequestOpts): Promise<TransportResponse>;
  /** Bridge-backed transports cannot refresh DataDome state from Node. */
  invalidateAndRetryOnce(reason: string, logger: Logger): Promise<boolean>;
  /** Release any held resources (e.g. daemon WS). Optional. */
  close?(): Promise<void>;
}

export class HomegateBridgeTransport implements Transport {
  constructor(
    readonly kind: TransportKind,
    private readonly inner: BridgeTransport,
    private readonly onClose?: () => Promise<void>,
  ) {}
  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: opts.hasBody
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: opts.body,
      timeout_ms: opts.timeoutMs,
      signal: opts.signal,
    });
    return { status: resp.status, body: resp.body };
  }
  async invalidateAndRetryOnce(): Promise<boolean> {
    // The bridge IS the user's real browser session — operator has to reload
    // Homegate in their browser if DataDome rotates.
    return false;
  }
  async close(): Promise<void> {
    if (this.onClose) await this.onClose();
  }
}

export interface SelectTransportOpts {
  dataDir: string;
  logger: Logger;
}

export async function selectTransport(opts: SelectTransportOpts): Promise<Transport> {
  const local = getCurrentBridge();
  if (local) {
    opts.logger.info('homegate: using in-process bridge transport');
    return new HomegateBridgeTransport('bridge-inproc', new BrowserBridgeTransport(local));
  }
  const daemon = await DaemonBridgeTransport.tryConnect(opts.dataDir);
  if (daemon) {
    opts.logger.info('homegate: using daemon bridge transport (cross-process)');
    return new HomegateBridgeTransport(
      'bridge-daemon',
      daemon,
      async () => { await daemon.close(); },
    );
  }
  throw new Error(
    'source-homegate requires the Wabe browser bridge. ' +
      'Start `wabe start` with the extension paired, or run `wabe bridge pair` to set it up.',
  );
}
```

- [ ] **Step 2: Update `plugins/source-homegate/src/index.ts`**

Change `selectTransport` call (now async) and surface dispose:

```ts
const plugin: Source = {
  name: 'source-homegate',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const dataDir = resolveDataDir();
    const transport = await selectTransport({ dataDir, logger: ctx.logger });
    pluginState.transport = transport;
    // ... rest of fetch body uses `transport` as before
  },
  async dispose(): Promise<void> {
    if (pluginState.transport?.close) {
      await pluginState.transport.close();
    }
    pluginState.transport = undefined;
  },
};

interface PluginState {
  transport?: Transport;
}
const pluginState: PluginState = {};
```

- [ ] **Step 3: Update / replace `plugins/source-homegate/test/transport.test.ts`**

Delete tests that exercise `PlaywrightTransport` or `UndiciTransport`. Add tests for the new selector:

```ts
import { describe, expect, it } from 'vitest';
import { selectTransport } from '../src/transport.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('selectTransport (homegate)', () => {
  it('throws when no in-process bridge and no daemon heartbeat', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wabe-hg-sel-'));
    await expect(selectTransport({ dataDir: tmp, logger })).rejects.toThrow(/browser bridge/i);
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

(In-process and daemon paths are integration-tested in `@wabe/browser-bridge`; the plugin test just covers the failure mode.)

- [ ] **Step 4: Drop dead Playwright dep**

Check `plugins/source-homegate/package.json`. If `@wabe/browser-runtime` was only used by the now-deleted `PlaywrightTransport`, remove it. Otherwise leave it. Run `grep -rn "browser-runtime" plugins/source-homegate/src/` to verify.

If the package is still imported elsewhere in source-homegate (e.g. `bootstrap.ts`, which is referenced by the deleted class), delete the now-unused files: `bootstrap.ts`, `cookies.ts`, `headers.ts` — but only if they have no other consumers. Run `grep -rn "from '\./bootstrap" plugins/source-homegate/src/` to verify.

- [ ] **Step 5: Update plugin README**

Edit `plugins/source-homegate/README.md`. Add at the top:

```markdown
## Requirements

`source-homegate` **requires the Wabe browser bridge**. DataDome (Homegate's
anti-bot stack) blocks any request not originating from a real Homegate page
context. Run `wabe bridge pair` once, load the extension, then start `wabe start`.

If no bridge is paired, plugin init fails fast with a clear error.
```

- [ ] **Step 6: Run all source-homegate tests**

Run: `pnpm --filter @wabe/source-homegate test`

Expected: green. Any cookie/bootstrap tests now obsolete should be removed (covered by Step 4).

- [ ] **Step 7: Commit**

```bash
git add plugins/source-homegate
git commit -S -m "feat(source-homegate): require bridge transport; drop Playwright fallback"
```

---

### Task 10: Source plugin transport selector — immoscout24-sitemap

**Files:**
- Modify: `plugins/source-immoscout24-sitemap/src/index.ts`
- Possibly: `plugins/source-immoscout24-sitemap/src/transport.ts` (if a similar selector exists; otherwise inline)
- Modify: `plugins/source-immoscout24-sitemap/README.md`
- Modify: `plugins/source-immoscout24-sitemap/package.json`

- [ ] **Step 1: Inspect current shape**

Run: `cat plugins/source-immoscout24-sitemap/src/index.ts | grep -n -E "BrowserBridge|Transport|playwright"`

Confirm where the bridge transport is constructed.

- [ ] **Step 2: Replace selection with daemon-aware version**

Mirror the homegate change: at plugin init, attempt `getCurrentBridge()` → `DaemonBridgeTransport.tryConnect(dataDir)` → throw with the same error message wording (substituting plugin name).

If the plugin currently uses `new BrowserBridgeTransport()` directly, factor into a `selectTransport(dataDir, logger)` helper inside `src/index.ts` (or `src/transport.ts` if you make one). Implementation pattern identical to Task 9 Step 1 but inlined into this plugin's structure — no shared package.

Add a `dispose()` to the plugin export that closes the transport if it has a `close()` method.

- [ ] **Step 3: Drop Playwright dep if present**

Check `plugins/source-immoscout24-sitemap/package.json`. Remove `@wabe/browser-runtime` if it appears, after confirming no other code paths use it.

- [ ] **Step 4: Update README**

Edit `plugins/source-immoscout24-sitemap/README.md`. Add the same "Requirements" block as Task 9 Step 5, with the plugin name swapped.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @wabe/source-immoscout24-sitemap test`

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add plugins/source-immoscout24-sitemap
git commit -S -m "feat(source-immoscout24-sitemap): require bridge transport; drop Playwright fallback"
```

---

### Task 11: `Source.dispose()` hook + pipeline call

**Files:**
- Modify: `packages/plugin-sdk/src/source.ts` (or wherever `Source` interface lives)
- Modify: `packages/server/src/pipeline.ts`
- Test: `packages/server/test/pipeline.test.ts` (existing or new)

- [ ] **Step 1: Locate the `Source` interface**

Run: `grep -rn "export interface Source" packages/plugin-sdk/`

Open the file the grep reveals.

- [ ] **Step 2: Add optional dispose**

```ts
export interface Source {
  name: string;
  configSchema: z.ZodTypeAny;
  fetch(ctx: Context): AsyncGenerator<Listing>;
  /** Optional. Called once when the pipeline shuts down; release WS / fds / etc. */
  dispose?(): Promise<void>;
}
```

- [ ] **Step 3: Write failing pipeline test**

In the existing server pipeline test (`packages/server/test/pipeline.test.ts` or similar — locate via `grep -rn "describe('pipeline" packages/server/test`), add:

```ts
it('calls plugin.dispose() once on pipeline shutdown', async () => {
  const disposed: string[] = [];
  const stubSource: Source = {
    name: 'stub',
    configSchema: z.object({}),
    async *fetch() { /* yields nothing */ },
    async dispose() { disposed.push('stub'); },
  };
  // wire stubSource into a pipeline factory + call shutdown
  const pipeline = await buildPipeline({ sources: [stubSource], /* ... */ });
  await pipeline.shutdown();
  expect(disposed).toEqual(['stub']);
});
```

(Adapt to whatever helpers the existing test uses.)

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @wabe/server test -- pipeline`

Expected: FAIL — pipeline doesn't currently invoke `dispose`.

- [ ] **Step 5: Implement disposal in pipeline shutdown**

In `packages/server/src/pipeline.ts` (or the file holding the shutdown chain), iterate plugins and call `dispose` with error logging:

```ts
async function shutdown(): Promise<void> {
  for (const src of sources) {
    if (typeof src.dispose === 'function') {
      try {
        await src.dispose();
      } catch (err) {
        logger.warn({ err, plugin: src.name }, 'plugin dispose() threw');
      }
    }
  }
  // ... existing shutdown logic
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @wabe/server test -- pipeline`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk/src/source.ts packages/server/src/pipeline.ts packages/server/test/pipeline.test.ts
git commit -S -m "feat(plugin-sdk,server): Source.dispose() hook called on pipeline shutdown"
```

---

### Task 12: `wabe doctor` — require bridge for DataDome sources

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Inspect current doctor command**

Read `packages/cli/src/commands/doctor.ts`. Identify how it loads the user's config (which sources are configured).

- [ ] **Step 2: Add DataDome-source check**

After the existing bridge probe, add:

```ts
const DATADOME_SOURCES = ['source-homegate', 'source-immoscout24-sitemap'];

const enabledDataDomeSources = configuredPlugins.filter((p) =>
  DATADOME_SOURCES.includes(p.name),
);

if (enabledDataDomeSources.length > 0) {
  const hb = readHeartbeat(dataDir);
  const ok = hb && hb.age_ms < 15_000 && hb.connected;
  if (!ok) {
    logger.error(
      { sources: enabledDataDomeSources.map((p) => p.name) },
      'DataDome-protected sources are configured but the bridge is unpaired or offline. ' +
        'Run `wabe bridge pair` and load the extension, then `wabe start`.',
    );
    process.exitCode = 1;
  }
}
```

(Adapt to the existing config-load API and logger style.)

- [ ] **Step 3: Manual smoke test (no daemon)**

Run with no daemon and a homegate-enabled config:

```bash
pnpm --filter @wabe/cli build
node packages/cli/dist/index.js doctor --config /tmp/test-config.yaml
```

Expected: non-zero exit, clear error message.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/doctor.ts
git commit -S -m "feat(cli): doctor requires bridge paired/connected for DataDome sources"
```

---

### Task 13: Doc updates — CLAUDE.md + research addendum

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/research/2026-05-18-homegate-investigation.md`

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, find the paragraph beginning "Bridge mode is daemon-only" (under "Conventions"). Replace it with:

```markdown
- Bridge mode supports two contexts. The daemon (`wabe start`) hosts the bridge server in-process; its source plugins dispatch via the `getCurrentBridge()` singleton (`BrowserBridgeTransport`). Sibling processes (`wabe scan --source ...`) read `${dataDir}/bridge.status.json`, open a `/dispatch` WebSocket to the daemon, and dispatch via `DaemonBridgeTransport`. If neither path is available, DataDome-protected sources fail fast at plugin init.
```

In the "Browser bridge" section, replace the "Known gap" bullet on Firefox/Chrome MV3 background suspension with:

```markdown
- Chrome MV3 keeps the WebSocket open via an offscreen document; the SW only wakes per-request. Firefox MV3 has no offscreen API — it still suspends after ~30 s idle and reconnects on the next alarm tick. For unattended Firefox runs, keep DevTools open on the background page; offscreen-equivalent for Firefox is a deferred follow-up.
```

- [ ] **Step 2: Append addendum to homegate investigation**

Append to `docs/research/2026-05-18-homegate-investigation.md`:

```markdown
## Addendum — 2026-05-19

Playwright fallback dropped from `source-homegate` and
`source-immoscout24-sitemap`. DataDome rejects any request that does not
originate from a genuine Homegate / ImmoScout page context. The Playwright
path issued requests from Node (or from Chromium's network stack, not the
page's hooked `fetch`), so DataDome blocked them anyway. Documented as
non-recoverable; bridge is now the only supported transport for these sources.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/research/2026-05-18-homegate-investigation.md
git commit -S -m "docs: bridge no longer daemon-only; record Playwright drop addendum"
```

---

## Phase 4 — Stream B: Chrome offscreen + liveness signal

### Task 14: Liveness tick on Firefox alarm + KEEPALIVE_MIN=1

**Files:**
- Modify: `apps/extension-wabe/src/background.ts`

- [ ] **Step 1: Update alarm constant and handler**

In `apps/extension-wabe/src/background.ts`:

Change:

```ts
const KEEPALIVE_MIN = 0.5;
```

to:

```ts
const KEEPALIVE_MIN = 1;
```

And update the alarm handler to write `lastAliveAt` when the socket is open:

```ts
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    void chrome.storage.local.set({ lastAliveAt: Date.now() });
  } else {
    void connect();
  }
});
```

Note: this is the **Firefox path**. The Chrome path will delete this alarm in Task 17; this task makes the Firefox path correct first so we have a stable baseline.

- [ ] **Step 2: Build extension**

Run: `pnpm --filter wabe-extension build`

Expected: success. Both dists.

- [ ] **Step 3: Commit**

```bash
git add apps/extension-wabe/src/background.ts
git commit -S -m "fix(extension): keepalive alarm period >=1min; write lastAliveAt on tick"
```

---

### Task 15: Popup uses `lastAliveAt`; widen `STALE_AFTER_MS`

**Files:**
- Modify: `apps/extension-wabe/src/popup.ts`

- [ ] **Step 1: Update popup**

In `apps/extension-wabe/src/popup.ts`:

```ts
const STALE_AFTER_MS = 90_000;
// ...
interface StoredState {
  bridgeUrl?: string;
  authToken?: string;
  lastConnectedAt?: number;
  lastRequestAt?: number;
  lastAliveAt?: number;
}
// ... in render():
const s = (await chrome.storage.local.get([
  'bridgeUrl',
  'authToken',
  'lastConnectedAt',
  'lastRequestAt',
  'lastAliveAt',
])) as StoredState;
// ...
const lastSeen = Math.max(
  s.lastConnectedAt ?? 0,
  s.lastRequestAt ?? 0,
  s.lastAliveAt ?? 0,
);
```

- [ ] **Step 2: Build extension**

Run: `pnpm --filter wabe-extension build`

Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/extension-wabe/src/popup.ts
git commit -S -m "fix(extension): popup uses lastAliveAt; widen STALE_AFTER_MS to 90s"
```

---

### Task 16: Chrome manifest — add `"offscreen"` permission

**Files:**
- Modify: `apps/extension-wabe/vite.config.ts`
- Modify: `apps/extension-wabe/manifest.json`

- [ ] **Step 1: Inspect vite build**

`vite.config.ts` reads `manifest.json` and adjusts it per browser. We need to add `"offscreen"` **only** to the Chrome dist.

- [ ] **Step 2: Edit vite.config.ts**

In `apps/extension-wabe/vite.config.ts`, after the existing `if (browser === 'firefox')` branch, add Chrome-specific tweaks:

```ts
if (browser === 'firefox') {
  manifest.background = { scripts: ['src/background.ts'] };
} else {
  // Chrome: offscreen API is supported; add the permission.
  const perms = Array.isArray(manifest.permissions) ? [...manifest.permissions] : [];
  if (!perms.includes('offscreen')) perms.push('offscreen');
  manifest.permissions = perms;
}
```

Also add `src/offscreen.html` as an additional input (Chrome only; Firefox will simply not load it):

```ts
plugins: [
  webExtension({
    manifest: () => manifest,
    additionalInputs:
      browser === 'chrome'
        ? ['src/popup.html', 'src/offscreen.html']
        : ['src/popup.html'],
    browser,
  }),
  // ...
],
```

- [ ] **Step 3: Leave `manifest.json` unchanged**

`manifest.json` is the source-of-truth pre-split. Don't add `"offscreen"` to it directly; the vite logic injects it.

- [ ] **Step 4: Build both dists; verify**

Run: `WABE_EXT_BROWSER=chrome pnpm --filter wabe-extension build && WABE_EXT_BROWSER=firefox pnpm --filter wabe-extension build`

Run: `cat apps/extension-wabe/dist/chrome/manifest.json | grep offscreen && ! cat apps/extension-wabe/dist/firefox/manifest.json | grep offscreen`

Expected: Chrome manifest contains `"offscreen"`; Firefox manifest does not.

- [ ] **Step 5: Commit**

```bash
git add apps/extension-wabe/vite.config.ts
git commit -S -m "build(extension): inject offscreen permission + entry only into chrome dist"
```

---

### Task 17: `offscreen.html` + `offscreen.ts` (WS client + reconnect + liveness tick)

**Files:**
- Create: `apps/extension-wabe/src/offscreen.html`
- Create: `apps/extension-wabe/src/offscreen.ts`

- [ ] **Step 1: Create the empty document**

`apps/extension-wabe/src/offscreen.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Wabe Bridge — offscreen</title>
  </head>
  <body>
    <script type="module" src="./offscreen.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `offscreen.ts`**

`apps/extension-wabe/src/offscreen.ts`:

```ts
export {};

/**
 * Wabe Bridge — offscreen document.
 *
 * Holds the long-lived WebSocket to the local @wabe/browser-bridge server.
 * The MV3 service worker would otherwise suspend after ~30s of idle and kill
 * the socket. The offscreen document does not suspend; it owns the WS for
 * the lifetime of the extension.
 *
 * Per-request flow:
 *  bridge server -> WS (this doc)
 *   -> chrome.runtime.sendMessage({ type: 'wabe-bridge:proxy', payload })
 *     -> background.ts (SW wakes)
 *       -> chrome.scripting.executeScript({ world: 'MAIN' })
 *     <- result
 *   <- sendMessage reply
 *  -> WS response back to bridge server
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const MAX_RECONNECT_DELAY_MS = 30_000;
const LIVENESS_TICK_MS = 10_000;

interface State {
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  everPaired: boolean;
  connecting: boolean;
}

const state: State = {
  ws: null,
  reconnectDelayMs: 1_000,
  reconnectTimer: null,
  everPaired: false,
  connecting: false,
};

const EXT_VERSION = chrome.runtime.getManifest().version;

async function readConfig(): Promise<{ bridgeUrl: string; token: string | null }> {
  const cfg = await chrome.storage.local.get(['bridgeUrl', 'authToken']);
  return {
    bridgeUrl: (cfg.bridgeUrl as string | undefined) ?? DEFAULT_BRIDGE_URL,
    token: (cfg.authToken as string | undefined) ?? null,
  };
}

function scheduleReconnect(): void {
  if (state.reconnectTimer !== null) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, state.reconnectDelayMs);
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

interface InPageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function proxyRequest(ws: WebSocket, msg: BridgeRequestMessage): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: 'wabe-bridge:proxy',
      payload: msg,
    })) as { ok: true; result: InPageFetchResult } | { ok: false; message: string };
    if (reply?.ok) {
      ws.send(
        JSON.stringify({
          type: 'response',
          id: msg.id,
          status: reply.result.status,
          headers: reply.result.headers,
          body: reply.result.body,
        }),
      );
      await chrome.storage.local.set({ lastRequestAt: Date.now() });
    } else {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: msg.id,
          message: reply?.message ?? 'background proxy failed',
        }),
      );
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        id: msg.id,
        message: (err as Error).message,
      }),
    );
  }
}

async function handleBridgeMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: { type?: string } & Record<string, unknown>;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'welcome') {
    state.reconnectDelayMs = 1_000;
    await chrome.storage.local.set({ lastConnectedAt: Date.now(), lastAliveAt: Date.now() });
    if (!state.everPaired) {
      state.everPaired = true;
      console.log('[wabe-bridge:offscreen] paired with wabe agent');
    }
    return;
  }
  if (msg.type === 'reject') {
    console.warn('[wabe-bridge:offscreen] rejected by server:', msg.reason);
    ws.close();
    return;
  }
  if (msg.type === 'request') {
    await proxyRequest(ws, msg as unknown as BridgeRequestMessage);
  }
}

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  state.connecting = true;
  const { bridgeUrl, token } = await readConfig();
  if (!token) {
    state.connecting = false;
    return;
  }
  let ws: WebSocket;
  try { ws = new WebSocket(bridgeUrl); } catch (err) {
    state.connecting = false;
    console.warn(`[wabe-bridge:offscreen] failed to open WS: ${(err as Error).message}`);
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  state.connecting = false;
  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        extension_version: EXT_VERSION,
        auth_token_hex: token,
      }),
    );
  });
  ws.addEventListener('message', (ev) => {
    void handleBridgeMessage(ws, typeof ev.data === 'string' ? ev.data : '');
  });
  ws.addEventListener('close', () => {
    state.ws = null;
    scheduleReconnect();
  });
  ws.addEventListener('error', () => { /* close follows */ });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wabe-bridge:reconnect') {
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
      state.ws = null;
    }
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.reconnectDelayMs = 1_000;
    void connect();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    void chrome.storage.local.set({ lastAliveAt: Date.now() });
  }
}, LIVENESS_TICK_MS);

void connect();
```

- [ ] **Step 3: Build extension (Chrome)**

Run: `WABE_EXT_BROWSER=chrome pnpm --filter wabe-extension build`

Expected: success; `dist/chrome/src/offscreen.html` and bundled offscreen JS present.

- [ ] **Step 4: Commit**

```bash
git add apps/extension-wabe/src/offscreen.html apps/extension-wabe/src/offscreen.ts
git commit -S -m "feat(extension): offscreen document holds long-lived WS (Chrome)"
```

---

### Task 18: Shrink Chrome SW; feature-detect offscreen

**Files:**
- Modify: `apps/extension-wabe/src/background.ts`

This is the largest single edit. Reorganize `background.ts` so:
- Top-level feature-detect picks Chrome path or Firefox path.
- Chrome path: no WS code; spawn offscreen + handle `wabe-bridge:proxy`.
- Firefox path: existing WS code (already lightly tweaked in Task 14).

- [ ] **Step 1: Rewrite `background.ts` shape**

Replace the entire file with the structure below. Keep helpers (`findExistingTabForOrigin`, `ensureTabForOrigin`, `inPageFetch`, `getTab`, `waitForTabComplete`, `TAB_HOMEPAGE`) intact. The Firefox-path WS/reconnect logic is preserved verbatim.

```ts
export {};

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const KEEPALIVE_ALARM = 'wabe-bridge-keepalive';
const KEEPALIVE_MIN = 1;
const MAX_RECONNECT_DELAY_MS = 30_000;
const OFFSCREEN_URL = 'src/offscreen.html';

// --------- Shared tab helpers (used by both Chrome SW + Firefox SW) ---------

const TAB_HOMEPAGE: Record<string, string> = {
  /* unchanged */
};

const tabReady = new Map<string, Promise<number>>();

function originFromHostUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function urlMatchPattern(origin: string): string {
  return `${origin}/*`;
}

async function findExistingTabForOrigin(origin: string): Promise<number | null> {
  /* unchanged from current implementation */
}
function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> { /* unchanged */ }
function getTab(tabId: number): Promise<chrome.tabs.Tab> { /* unchanged */ }
async function ensureTabForOrigin(origin: string): Promise<number> { /* unchanged */ }

interface InPageFetchArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
interface InPageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}
async function inPageFetch(args: InPageFetchArgs): Promise<InPageFetchResult> {
  /* unchanged */
}

void originFromHostUrl;

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

async function executeProxyRequest(msg: BridgeRequestMessage): Promise<InPageFetchResult> {
  const targetOrigin = new URL(msg.url).origin;
  const tabId = await ensureTabForOrigin(targetOrigin);
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: inPageFetch,
    args: [
      {
        method: msg.method,
        url: msg.url,
        headers: msg.headers ?? {},
        body: msg.body,
        timeoutMs: msg.timeout_ms ?? 30_000,
      },
    ],
  });
  if (!exec || exec.result === undefined) {
    throw new Error('executeScript returned no result');
  }
  return exec.result as InPageFetchResult;
}

// --------- Path selection ---------

const HAS_OFFSCREEN = typeof (chrome as typeof chrome & { offscreen?: unknown }).offscreen !== 'undefined';

if (HAS_OFFSCREEN) {
  installChromePath();
} else {
  installFirefoxPath();
}

// --------- Chrome path ---------

async function ensureOffscreen(): Promise<void> {
  const offscreenAny = (chrome as typeof chrome & {
    offscreen: {
      hasDocument(): Promise<boolean>;
      createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
    };
  }).offscreen;
  const exists = await offscreenAny.hasDocument();
  if (exists) return;
  await offscreenAny.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'persistent WebSocket to local Wabe agent',
  });
}

function installChromePath(): void {
  chrome.runtime.onInstalled.addListener(() => { void ensureOffscreen(); });
  chrome.runtime.onStartup.addListener(() => { void ensureOffscreen(); });
  void ensureOffscreen();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'wabe-bridge:proxy') {
      // Self-heal: offscreen may have been evicted by Chrome low-memory reclaim.
      void ensureOffscreen()
        .then(() => executeProxyRequest(message.payload as BridgeRequestMessage))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true; // async
    }
    if (message?.type === 'wabe-bridge:reconnect') {
      // Forward to offscreen; offscreen's own onMessage handler resets the socket.
      void ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' }))
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    return false;
  });
}

// --------- Firefox path (existing WS-in-SW behavior) ---------

interface FfState {
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  everPaired: boolean;
  connecting: boolean;
}

const ffState: FfState = {
  ws: null,
  reconnectDelayMs: 1_000,
  reconnectTimer: null,
  everPaired: false,
  connecting: false,
};

function installFirefoxPath(): void {
  // Reuse the current background.ts WS logic, now factored into installFirefoxPath().
  // Copy-paste verbatim: readConfig, scheduleReconnect, proxyRequest, handleBridgeMessage,
  // connect, onMessage (reconnect), onInstalled/onStartup, alarms.create+listener.
  // The alarm listener writes lastAliveAt when ws is OPEN (Task 14 change).
  //
  // NOTE: this branch never runs in the Chrome dist because HAS_OFFSCREEN
  // short-circuits; in Firefox `chrome.offscreen` is undefined.

  /* ...existing background.ts body wrapped into this function... */
}
```

(The `installFirefoxPath` body is a verbatim move of the existing background.ts WS logic — preserve every behavior.)

- [ ] **Step 2: Build both dists**

Run:

```bash
WABE_EXT_BROWSER=chrome pnpm --filter wabe-extension build
WABE_EXT_BROWSER=firefox pnpm --filter wabe-extension build
```

Expected: both succeed.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter wabe-extension typecheck` (or `pnpm --filter wabe-extension exec tsc --noEmit`)

Expected: no errors. If `chrome.offscreen` types are missing, add `@types/chrome` or extend the cast at the use site (the `as typeof chrome & { offscreen: ... }` cast above does this inline).

- [ ] **Step 4: Commit**

```bash
git add apps/extension-wabe/src/background.ts
git commit -S -m "feat(extension): chrome path uses offscreen for WS; firefox keeps SW alarm path"
```

---

### Task 19: Extension README — manual smoke checklist + Firefox limitation

**Files:**
- Modify: `apps/extension-wabe/README.md`

- [ ] **Step 1: Append checklist**

Append to `apps/extension-wabe/README.md`:

```markdown
## Manual smoke test (Chrome offscreen keepalive)

vitest cannot host an MV3 context. After modifying the extension, run this
checklist before claiming a change works:

1. Build: `WABE_EXT_BROWSER=chrome pnpm --filter wabe-extension build`
2. `chrome://extensions` → Developer mode → "Load unpacked" → `apps/extension-wabe/dist/chrome`
3. Click the extension's action icon; popup opens.
4. Run `wabe bridge pair` in a terminal; copy the URL + 64-hex token into the popup; click Save.
5. Wait until the popup shows "connected".
6. **Close the DevTools window for the extension's background context** (the whole point of this design is that it works without DevTools).
7. Start `wabe start` if not running.
8. `wabe doctor` — expect bridge `connected: true`.
9. Wait 5 minutes. `wabe doctor` again — still `connected: true`.
10. Trigger a Homegate scan: `wabe scan --source source-homegate`. Listings persisted.
11. Close laptop lid for 10 minutes; reopen. Within 30 s, popup back to "connected".

## Manual smoke test (Firefox)

Firefox has no offscreen API. The SW suspends after ~30 s idle; the alarm
reconnects on its next 1-minute tick. Acceptable for interactive use.

1. Build: `WABE_EXT_BROWSER=firefox pnpm --filter wabe-extension build`
2. `about:debugging` → "This Firefox" → "Load Temporary Add-on" → pick `manifest.json` in `apps/extension-wabe/dist/firefox`
3. Pair as for Chrome.
4. **Grant host permissions in `about:addons`** (Firefox does not auto-grant MV3 host permissions).
5. Confirm `wabe doctor` reports bridge connected within 90 s.

## Manual smoke test (cross-process)

With `wabe start` daemon running + extension paired:

1. In a second terminal: `wabe scan --source source-homegate`.
2. Listings persist; no Playwright fallback messages in logs.
3. `wabe doctor` reports bridge `inflight: 0` after the scan completes.
```

- [ ] **Step 2: Commit**

```bash
git add apps/extension-wabe/README.md
git commit -S -m "docs(extension): manual smoke checklists for offscreen + firefox + cross-process"
```

---

## Phase 5 — Verification

### Task 20: Whole-repo typecheck, lint, test

- [ ] **Step 1: Full repo CI gate**

Run: `pnpm ci`

Expected: lint clean, format clean, typecheck clean, all tests green.

If anything fails, fix at the failing site; commit per-fix.

- [ ] **Step 2: Smoke the Chrome path manually**

Walk the checklist in `apps/extension-wabe/README.md` ("Manual smoke test (Chrome offscreen keepalive)").

- [ ] **Step 3: Smoke cross-process**

Walk the checklist "Manual smoke test (cross-process)".

- [ ] **Step 4: Optional — smoke Firefox**

Walk the Firefox checklist if a Firefox profile is available.

- [ ] **Step 5: Final commit (if any doc tweaks needed during smoke)**

Only if README needed clarification based on smoke findings.

```bash
git add apps/extension-wabe/README.md
git commit -S -m "docs(extension): tweak smoke checklist based on manual run"
```

---

## Open PR

After all tasks complete and smoke passes:

```bash
git push -u origin feat/bridge-keepalive-and-fanout
gh pr create --title "Bridge keepalive + cross-process fan-out" --body "$(cat <<'EOF'
## Summary
- Move Chrome extension's WebSocket into an offscreen document so it survives SW suspension. Firefox keeps the SW + alarm path.
- Add `/dispatch` WS path + `DaemonBridgeTransport` so sibling CLI processes (`wabe scan --source X`) can route through the daemon's paired extension.
- Drop Playwright fallback for DataDome-protected sources (source-homegate, source-immoscout24-sitemap); bridge is now required.
- Fold in 7 Copilot review fixes from PR #1: loopback enforcement, CSP widening, `host_permissions` cleanup, DNR rule scoping, alarm-period fix, popup liveness signal, AbortSignal propagation.

Spec: `docs/superpowers/specs/2026-05-19-bridge-keepalive-and-fanout-design.md`
Plan: `docs/superpowers/plans/2026-05-19-bridge-keepalive-and-fanout.md`

## Test plan
- [x] `pnpm ci` green
- [x] Chrome offscreen survives 5+ minute idle without DevTools
- [x] `wabe scan --source source-homegate` (sibling process) succeeds against daemon
- [x] `wabe doctor` hard-fails when DataDome sources configured + bridge offline
- [ ] Firefox smoke (optional, if profile available)
EOF
)"
```

---

## Self-review notes

- Each phase ships independent green CI. Phase 1 + 2 + 3 are all vitest-testable; Phase 4 requires manual smoke.
- File map covers every spec item: loopback (T1), DNR (T2), CSP (T3), AbortSignal (T4/T5), fan-out server (T6/T7), DaemonBridgeTransport (T8), source selectors (T9/T10), dispose (T11), doctor (T12), docs (T13), Firefox alarm (T14), popup (T15), manifest (T16), offscreen (T17), background.ts (T18), README (T19), verification (T20).
- No placeholders; every step has either code or an exact command.
- Type names consistent: `BridgeTransport` (aliased from `@wabe/browser-bridge.Transport`), `Transport` (plugin's local interface), `HomegateBridgeTransport`, `DaemonBridgeTransport`, `BrowserBridgeTransport`. Function names: `selectTransport` (plugin), `tryConnect` (DaemonBridgeTransport static).
- Failure modes from spec all covered: no-daemon → throw; no-extension → server replies `error`; mid-flight disconnect → drain inflight + reject; abort → drop inflight; offscreen eviction → re-create on every `onMessage`.
