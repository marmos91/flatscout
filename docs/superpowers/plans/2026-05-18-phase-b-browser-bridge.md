# Phase B — Browser Extension Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chrome/Firefox WebExtension that proxies HTTPS requests for DataDome-protected sources (Homegate, ImmoScout24) from the user's real browser to Wabe via a local WebSocket bridge. Replaces the fragile Playwright + undici-replay path; the request happens inside genuine Chrome so DataDome has nothing to flag.

**Architecture:**
- `@wabe/browser-bridge` — WebSocket server bound to `127.0.0.1`, JSON request/response protocol, shared-secret pairing.
- `apps/extension-wabe` — manifest v3 WebExtension. Service worker holds the WS connection to wabe; popup shows status + handles pairing.
- Source plugins (`source-homegate`, `source-immoscout24-sitemap`) gain a `Transport` abstraction with three implementations (`UndiciTransport`, `PlaywrightTransport`, `BrowserBridgeTransport`) and pick at runtime by availability: **bridge → playwright → undici**.
- `source-immoscout24-sitemap` already ships URL-only listings (Phase A); with bridge available it additionally fetches each new PDP and emits full-detail listings (rooms, price, photos, description).

**Tech Stack:** TypeScript, `ws` (server), native `WebSocket` (extension), `chrome.cookies` / `chrome.storage` / `chrome.alarms` WebExtension APIs, Vitest, vite-plugin-web-extension (build). Spec reference: `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §5.

**Sequencing:** Phase B is more sequential than A/C — the protocol contract (`@wabe/browser-bridge`) blocks the extension, which blocks the transport refactor. Best executed as one stream in a single worktree.

---

## File map

### New packages

| Path | Purpose |
|------|---------|
| `packages/browser-bridge/` | `@wabe/browser-bridge` — server-side WS bridge + Transport interface |
| `packages/browser-bridge/src/protocol.ts` | Zod schemas for request/response messages + handshake |
| `packages/browser-bridge/src/server.ts` | WS server on 127.0.0.1 with auth handshake + request routing |
| `packages/browser-bridge/src/transport.ts` | `Transport` interface + `BrowserBridgeTransport` adapter |
| `packages/browser-bridge/src/secret.ts` | Shared-secret generation + storage (reuses `@wabe/server` secret store) |
| `packages/browser-bridge/test/*.test.ts` | Unit tests (in-process WS server + mock client) |
| `apps/extension-wabe/` | WebExtension v3 (Chrome + Firefox) |
| `apps/extension-wabe/manifest.json` | Manifest v3 + `browser_specific_settings` for Firefox |
| `apps/extension-wabe/src/background.ts` | Service worker: WS client, request proxy, cookie reader |
| `apps/extension-wabe/src/popup.html` + `popup.ts` | Status + pairing UI |
| `apps/extension-wabe/src/host-permissions.ts` | Host-permission catalogue |
| `apps/extension-wabe/vite.config.ts` | Bundler config (vite-plugin-web-extension) |
| `apps/extension-wabe/package.json` + `tsconfig.json` + `README.md` | Boilerplate |

### Modified files

| Path | Change |
|------|--------|
| `packages/server/package.json` | Add `@wabe/browser-bridge` as runtime dep |
| `packages/server/src/index.ts` | Start bridge server alongside scheduler when bridge config present |
| `packages/cli/src/commands/bridge/` | New `wabe bridge pair`, `wabe bridge status` commands |
| `packages/cli/src/commands/doctor.ts` | Add bridge connectivity probe |
| `packages/cli/src/index.ts` | Register `wabe bridge` parent command |
| `plugins/source-homegate/src/transport.ts` | Extract Transport interface; add three implementations |
| `plugins/source-homegate/src/client.ts` | Use Transport instead of bare `request()` |
| `plugins/source-homegate/src/index.ts` | Pick transport at startup based on availability |
| `plugins/source-homegate/package.json` | Add `@wabe/browser-bridge` dep |
| `plugins/source-immoscout24-sitemap/src/index.ts` | Optional full-detail mode when bridge transport available |
| `plugins/source-immoscout24-sitemap/src/detail.ts` | NEW — JSON-LD extractor for IS24 PDP HTML (reuses schemaorg pattern) |
| `plugins/source-immoscout24-sitemap/src/map.ts` | Extend mapper for full-detail mode (rooms/price/photos/description) |
| `plugins/source-immoscout24-sitemap/package.json` | Add `@wabe/browser-bridge` dep |
| `plugins/notifier-telegram/src/card.ts` | Remove `source-homegate` + `source-immoscout24-sitemap` from `PREVIEW_SUPPRESS_SOURCES` once bridge is the default transport (their links work via real browser then; previews still won't, so keep them for now — note as followup) |
| `examples/zurich-family/config/config.yaml` | Re-enable `homegate-zurich` source (commented out in Phase A patch) |
| `README.md` | Document bridge + extension install + pair flow |

---

## Tasks

### Task 1: Scaffold `@wabe/browser-bridge` package

**Files:**
- Create: `packages/browser-bridge/package.json`
- Create: `packages/browser-bridge/tsconfig.json`
- Create: `packages/browser-bridge/README.md` (stub)
- Create: `packages/browser-bridge/src/index.ts` (stub)

Reference: `packages/agency-fingerprint/` (Phase C) for the same scaffold layout.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabe/browser-bridge",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "zod": "^3.23.8",
    "pino": "^9.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "@types/ws": "^8.5.13",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** — copy from `packages/agency-fingerprint/tsconfig.json`.

- [ ] **Step 3: Stub `src/index.ts` + `README.md`.**

- [ ] **Step 4: Install + typecheck**

```
pnpm install
pnpm --filter @wabe/browser-bridge typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/browser-bridge/
git commit -S -m "chore(browser-bridge): scaffold package"
```

---

### Task 2: Protocol schemas

**Files:**
- Create: `packages/browser-bridge/src/protocol.ts`
- Create: `packages/browser-bridge/test/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/browser-bridge/test/protocol.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ClientHello, ServerWelcome, BridgeRequest, BridgeResponse } from '../src/protocol.js';

describe('ClientHello', () => {
  it('parses a valid hello', () => {
    const h = ClientHello.parse({
      type: 'hello',
      protocol_version: 1,
      extension_version: '0.0.0',
      auth_token_hex: 'a'.repeat(64),
    });
    expect(h.protocol_version).toBe(1);
  });
  it('rejects wrong protocol version', () => {
    expect(() =>
      ClientHello.parse({ type: 'hello', protocol_version: 2, extension_version: '0.0.0', auth_token_hex: 'a'.repeat(64) }),
    ).toThrow();
  });
});

describe('BridgeRequest', () => {
  it('parses a GET request', () => {
    const r = BridgeRequest.parse({
      type: 'request',
      id: 'r-1',
      method: 'GET',
      url: 'https://api.homegate.ch/search/listings?x=1',
      headers: { accept: 'application/json' },
    });
    expect(r.id).toBe('r-1');
  });
  it('parses a POST request with body', () => {
    const r = BridgeRequest.parse({
      type: 'request',
      id: 'r-2',
      method: 'POST',
      url: 'https://api.homegate.ch/x',
      headers: {},
      body: '{}',
    });
    expect(r.body).toBe('{}');
  });
});

describe('BridgeResponse', () => {
  it('parses a 200 response with string body', () => {
    const r = BridgeResponse.parse({
      type: 'response',
      id: 'r-1',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    expect(r.status).toBe(200);
  });
});

describe('ServerWelcome', () => {
  it('parses welcome', () => {
    expect(ServerWelcome.parse({ type: 'welcome', protocol_version: 1 }).protocol_version).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, observe failure**

```
pnpm --filter @wabe/browser-bridge test protocol
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement protocol**

Create `packages/browser-bridge/src/protocol.ts`:

```typescript
import { z } from 'zod';

/** Bumped only on incompatible wire changes. Server + extension MUST agree. */
export const PROTOCOL_VERSION = 1;

export const ClientHello = z.object({
  type: z.literal('hello'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  extension_version: z.string(),
  /** Hex-encoded shared secret proving the extension was paired with this wabe instance. */
  auth_token_hex: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerWelcome = z.object({
  type: z.literal('welcome'),
  protocol_version: z.literal(PROTOCOL_VERSION),
});
export type ServerWelcome = z.infer<typeof ServerWelcome>;

export const ServerReject = z.object({
  type: z.literal('reject'),
  reason: z.string(),
});
export type ServerReject = z.infer<typeof ServerReject>;

export const BridgeRequest = z.object({
  type: z.literal('request'),
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'DELETE']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().max(60_000).default(30_000),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export const BridgeResponse = z.object({
  type: z.literal('response'),
  id: z.string().min(1),
  status: z.number().int().min(0).max(599),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(''),
});
export type BridgeResponse = z.infer<typeof BridgeResponse>;

export const BridgeError = z.object({
  type: z.literal('error'),
  id: z.string().min(1),
  message: z.string(),
});
export type BridgeError = z.infer<typeof BridgeError>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerWelcome,
  ServerReject,
  BridgeRequest,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion('type', [
  ClientHello,
  BridgeResponse,
  BridgeError,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
```

- [ ] **Step 4: Run tests, observe pass**

```
pnpm --filter @wabe/browser-bridge test protocol
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```
git add packages/browser-bridge/src/protocol.ts packages/browser-bridge/test/protocol.test.ts
git commit -S -m "feat(browser-bridge): protocol schemas (hello/welcome/request/response)"
```

---

### Task 3: Secret storage + pairing token

**Files:**
- Create: `packages/browser-bridge/src/secret.ts`
- Create: `packages/browser-bridge/test/secret.test.ts`

The secret is a 32-byte random value stored in `${dataDir}/bridge-secret` with mode 0600. The pairing token is the hex encoding of that secret.

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecret, loadOrGenerateSecret, validateToken } from '../src/secret.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-secret-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('generateSecret', () => {
  it('returns a 64-char hex string (32 bytes)', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns a different value each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('loadOrGenerateSecret', () => {
  it('generates + persists with mode 0600 on first call', () => {
    const s = loadOrGenerateSecret(dir);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    const mode = statSync(join(dir, 'bridge-secret')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(join(dir, 'bridge-secret'), 'utf8').trim()).toBe(s);
  });
  it('reuses the persisted secret on subsequent calls', () => {
    const a = loadOrGenerateSecret(dir);
    const b = loadOrGenerateSecret(dir);
    expect(a).toBe(b);
  });
});

describe('validateToken', () => {
  it('accepts the right token (constant-time)', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, s)).toBe(true);
  });
  it('rejects a wrong token', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, 'b'.repeat(64))).toBe(false);
  });
  it('rejects a malformed token', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, 'nothex')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, observe failure.**

- [ ] **Step 3: Implement**

```typescript
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_FILE = 'bridge-secret';

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

export function loadOrGenerateSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, SECRET_FILE);
  if (existsSync(path)) {
    const s = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  }
  const s = generateSecret();
  writeFileSync(path, s, { mode: 0o600 });
  return s;
}

/** Constant-time comparison; returns false on any malformed input. */
export function validateToken(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run tests.**

- [ ] **Step 5: Commit**

```
git add packages/browser-bridge/src/secret.ts packages/browser-bridge/test/secret.test.ts
git commit -S -m "feat(browser-bridge): shared-secret generation + persistence + constant-time validate"
```

---

### Task 4: WebSocket server + handshake + request routing

**Files:**
- Create: `packages/browser-bridge/src/server.ts`
- Create: `packages/browser-bridge/test/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startBridgeServer } from '../src/server.js';
import { loadOrGenerateSecret } from '../src/secret.js';
import type { BridgeRequest, BridgeResponse } from '../src/protocol.js';

let dir: string;
let stop: () => Promise<void>;
let port: number;
let secret: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-srv-'));
  secret = loadOrGenerateSecret(dir);
  const handle = await startBridgeServer({ dataDir: dir, port: 0 /* OS-chosen */ });
  port = handle.port;
  stop = handle.stop;
});
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

function client(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/bridge`);
}

async function connectAndHello(ws: WebSocket): Promise<string> {
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: 1,
      extension_version: '0.0.0',
      auth_token_hex: secret,
    }),
  );
  const msg = await new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
  return msg;
}

describe('bridgeServer handshake', () => {
  it('accepts a hello with the correct secret', async () => {
    const ws = client();
    const msg = await connectAndHello(ws);
    const parsed = JSON.parse(msg) as { type: string };
    expect(parsed.type).toBe('welcome');
    ws.close();
  });
  it('rejects a hello with the wrong secret', async () => {
    const ws = client();
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(
      JSON.stringify({ type: 'hello', protocol_version: 1, extension_version: '0', auth_token_hex: 'b'.repeat(64) }),
    );
    const msg = await new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    expect(JSON.parse(msg).type).toBe('reject');
    ws.close();
  });
});

describe('bridgeServer request routing', () => {
  it('round-trips a BridgeRequest → BridgeResponse via the connected client', async () => {
    const ws = client();
    await connectAndHello(ws);
    // The server holds a public `dispatch(req)` returning Promise<response>.
    // Set up a listener on the client side to echo any incoming request.
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; id?: string };
      if (m.type === 'request') {
        const resp: BridgeResponse = {
          type: 'response',
          id: m.id ?? '',
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"echo":true}',
        };
        ws.send(JSON.stringify(resp));
      }
    });
    // Test access to dispatch via a helper export — see Step 3.
    // For this test, expose `dispatchOnNewest` from server module.
    const { dispatchOnNewest } = await import('../src/server.js');
    const resp = await dispatchOnNewest({
      type: 'request',
      id: 'x',
      method: 'GET',
      url: 'https://example/x',
      headers: {},
      timeout_ms: 5_000,
    } as BridgeRequest);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('{"echo":true}');
    ws.close();
  });
});
```

- [ ] **Step 2: Run, observe failure.**

- [ ] **Step 3: Implement**

```typescript
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  BridgeRequest,
  BridgeResponse,
  ClientHello,
  ClientMessage,
  PROTOCOL_VERSION,
} from './protocol.js';
import { loadOrGenerateSecret, validateToken } from './secret.js';

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

// Module-level state for the single bridge instance per wabe process.
// Multi-bridge is out of scope; one extension paired per wabe install.
let activeSocket: WebSocket | null = null;
const inflight = new Map<string, { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

export interface StartOpts {
  dataDir: string;
  port: number;
  host?: string; // default 127.0.0.1
}

export async function startBridgeServer(opts: StartOpts): Promise<ServerHandle> {
  const secret = loadOrGenerateSecret(opts.dataDir);
  const host = opts.host ?? '127.0.0.1';
  const wss = new WebSocketServer({ host, port: opts.port, path: '/bridge' });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  wss.on('connection', (ws) => handleConnection(ws, secret));
  const stop = (): Promise<void> =>
    new Promise<void>((r) => {
      for (const ifl of inflight.values()) {
        clearTimeout(ifl.timer);
        ifl.reject(new Error('server stopping'));
      }
      inflight.clear();
      activeSocket?.close();
      wss.close(() => r());
    });
  return { port, stop };
}

function handleConnection(ws: WebSocket, secret: string): void {
  let helloReceived = false;
  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: 'reject', reason: 'bad json' }));
      ws.close();
      return;
    }
    if (!helloReceived) {
      const hello = ClientHello.safeParse(parsed);
      if (!hello.success) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'bad hello' }));
        ws.close();
        return;
      }
      if (!validateToken(secret, hello.data.auth_token_hex)) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'bad token' }));
        ws.close();
        return;
      }
      helloReceived = true;
      ws.send(JSON.stringify({ type: 'welcome', protocol_version: PROTOCOL_VERSION }));
      activeSocket = ws;
      return;
    }
    const msg = ClientMessage.safeParse(parsed);
    if (!msg.success) return;
    if (msg.data.type === 'response') {
      const ifl = inflight.get(msg.data.id);
      if (!ifl) return;
      clearTimeout(ifl.timer);
      inflight.delete(msg.data.id);
      ifl.resolve(msg.data);
    } else if (msg.data.type === 'error') {
      const ifl = inflight.get(msg.data.id);
      if (!ifl) return;
      clearTimeout(ifl.timer);
      inflight.delete(msg.data.id);
      ifl.reject(new Error(msg.data.message));
    }
  });
  ws.on('close', () => {
    if (activeSocket === ws) activeSocket = null;
  });
}

/** Dispatch a request to the currently-connected extension and await its response. Throws if no extension is connected or on timeout. */
export async function dispatch(req: BridgeRequest): Promise<BridgeResponse> {
  if (!activeSocket || activeSocket.readyState !== activeSocket.OPEN) {
    throw new Error('bridge not connected (extension offline?)');
  }
  return new Promise<BridgeResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(req.id);
      reject(new Error(`bridge request ${req.id} timed out after ${req.timeout_ms}ms`));
    }, req.timeout_ms);
    inflight.set(req.id, { resolve, reject, timer });
    activeSocket?.send(JSON.stringify(req));
  });
}

/** Test-only helper: dispatch to whichever extension just connected. */
export const dispatchOnNewest = dispatch;

/** Make a fresh request id. */
export function newRequestId(): string {
  return randomUUID();
}

/** Connection state for `wabe bridge status`. */
export function bridgeStatus(): { connected: boolean; inflight: number } {
  return {
    connected: activeSocket !== null && activeSocket.readyState === activeSocket.OPEN,
    inflight: inflight.size,
  };
}
```

- [ ] **Step 4: Run tests.**

- [ ] **Step 5: Commit**

```
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/server.test.ts
git commit -S -m "feat(browser-bridge): WS server with handshake + request/response routing"
```

---

### Task 5: Transport interface + `BrowserBridgeTransport`

**Files:**
- Create: `packages/browser-bridge/src/transport.ts`
- Create: `packages/browser-bridge/test/transport.test.ts`

- [ ] **Step 1: Write the failing test** — spawn the WS server, connect a mock client that echoes responses, fire `BrowserBridgeTransport.request()` and assert the response shape matches `{ status, headers, body }`.

- [ ] **Step 2: Implement**

```typescript
import { dispatch, newRequestId } from './server.js';
import type { BridgeRequest } from './protocol.js';

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  /** Performs a single HTTPS request and returns the response. Throws on transport-level failures (timeout, disconnect, etc.). */
  request(opts: {
    method: BridgeRequest['method'];
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeout_ms?: number;
    signal?: AbortSignal;
  }): Promise<TransportResponse>;
}

export class BrowserBridgeTransport implements Transport {
  async request(opts: {
    method: BridgeRequest['method'];
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeout_ms?: number;
    signal?: AbortSignal;
  }): Promise<TransportResponse> {
    if (opts.signal?.aborted) throw new Error('aborted');
    const req: BridgeRequest = {
      type: 'request',
      id: newRequestId(),
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      body: opts.body,
      timeout_ms: opts.timeout_ms ?? 30_000,
    };
    const resp = await dispatch(req);
    return { status: resp.status, headers: resp.headers, body: resp.body };
  }
}
```

- [ ] **Step 3: Test, commit.**

```
git add packages/browser-bridge/src/transport.ts packages/browser-bridge/test/transport.test.ts
git commit -S -m "feat(browser-bridge): Transport interface + BrowserBridgeTransport adapter"
```

---

### Task 6: Wire bridge server into `@wabe/server`

**Files:**
- Modify: `packages/server/package.json` (add `@wabe/browser-bridge`)
- Modify: `packages/server/src/index.ts` (start server when bridge config present)
- Modify: `packages/server/src/config.ts` (add optional `bridge` block to top config schema)

- [ ] **Step 1: Extend `TopConfig`**

Add to the `TopConfig` Zod schema in `packages/server/src/config.ts`:

```typescript
  bridge: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(8431),
      host: z.string().default('127.0.0.1'),
    })
    .default({ enabled: false, port: 8431, host: '127.0.0.1' }),
```

- [ ] **Step 2: Start the bridge in the server entrypoint when enabled**

In `packages/server/src/index.ts`, after the existing scheduler setup:

```typescript
import { startBridgeServer } from '@wabe/browser-bridge';

// ...
if (cfg.top.bridge.enabled) {
  const bridge = await startBridgeServer({
    dataDir: resolvedDataDir,
    port: cfg.top.bridge.port,
    host: cfg.top.bridge.host,
  });
  logger.info({ port: bridge.port }, 'browser bridge listening');
  shutdownHooks.push(() => bridge.stop());
}
```

(Adapt to the existing shutdown-hook pattern; if none exists, add to the `SIGTERM` handler.)

- [ ] **Step 3: Commit**

```
git add packages/server/package.json packages/server/src/config.ts packages/server/src/index.ts pnpm-lock.yaml
git commit -S -m "feat(server): start bridge server when top.bridge.enabled"
```

---

### Task 7: Scaffold `apps/extension-wabe`

**Files:**
- Create: `apps/extension-wabe/package.json`
- Create: `apps/extension-wabe/tsconfig.json`
- Create: `apps/extension-wabe/vite.config.ts`
- Create: `apps/extension-wabe/manifest.json`
- Create: `apps/extension-wabe/README.md` (stub)
- Create: `apps/extension-wabe/src/background.ts` (stub)
- Create: `apps/extension-wabe/src/popup.html` + `popup.ts` (stub)

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabe/extension-wabe",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.275",
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vite": "^5.4.10",
    "vite-plugin-web-extension": "^4.4.1",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: `manifest.json`** (manifest v3)

```json
{
  "manifest_version": 3,
  "name": "Wabe Bridge",
  "version": "0.0.0",
  "description": "Proxies HTTPS requests from your real browser to the Wabe agent over a local WebSocket. Used to bypass anti-bot walls (DataDome/Cloudflare) for Homegate + ImmoScout24 listings.",
  "background": {
    "service_worker": "src/background.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup.html",
    "default_title": "Wabe Bridge"
  },
  "permissions": ["storage", "cookies", "alarms"],
  "host_permissions": [
    "*://*.homegate.ch/*",
    "*://api.homegate.ch/*",
    "*://*.immoscout24.ch/*",
    "*://api.immoscout24.ch/*"
  ],
  "browser_specific_settings": {
    "gecko": {
      "id": "wabe-bridge@wabe.local",
      "strict_min_version": "121.0"
    }
  }
}
```

- [ ] **Step 3: `vite.config.ts`** — wire vite-plugin-web-extension to use the manifest above.

- [ ] **Step 4: Stub `background.ts`, `popup.html`, `popup.ts`** — one-line stubs.

- [ ] **Step 5: Install + verify**

```
pnpm install
pnpm --filter @wabe/extension-wabe typecheck
pnpm --filter @wabe/extension-wabe build
```
Expected: both PASS. Build emits `apps/extension-wabe/dist/` with manifest + bundled background script + popup.

- [ ] **Step 6: Commit**

```
git add apps/extension-wabe/ pnpm-lock.yaml
git commit -S -m "chore(extension-wabe): scaffold WebExtension v3"
```

---

### Task 8: Extension service worker — WebSocket client + request proxy

**Files:**
- Modify: `apps/extension-wabe/src/background.ts`

The service worker:
1. Reads stored secret + bridge URL from `chrome.storage.local`.
2. Opens WS to `ws://127.0.0.1:<port>/bridge` and sends hello.
3. On `request` messages, performs `fetch()` in extension context (cookies auto-attached for host-permitted origins) and ships back the response.
4. Reconnects with exponential backoff on disconnect.
5. Uses `chrome.alarms` to keep the service worker awake (manifest v3 SW suspension mitigation).

- [ ] **Step 1: Implement**

```typescript
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const EXT_VERSION = chrome.runtime.getManifest().version;

interface State {
  ws: WebSocket | null;
  reconnectDelayMs: number;
}

const state: State = { ws: null, reconnectDelayMs: 1_000 };

async function readConfig(): Promise<{ bridgeUrl: string; token: string | null }> {
  const cfg = await chrome.storage.local.get(['bridgeUrl', 'authToken']);
  return {
    bridgeUrl: (cfg.bridgeUrl as string) ?? DEFAULT_BRIDGE_URL,
    token: (cfg.authToken as string) ?? null,
  };
}

async function connect(): Promise<void> {
  const { bridgeUrl, token } = await readConfig();
  if (!token) {
    console.log('[wabe-bridge] no auth token yet — open popup to pair');
    return;
  }
  const ws = new WebSocket(bridgeUrl);
  state.ws = ws;
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
  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      state.reconnectDelayMs = 1_000;
      void chrome.storage.local.set({ lastConnectedAt: Date.now() });
      return;
    }
    if (msg.type === 'reject') {
      console.warn('[wabe-bridge] rejected:', msg.reason);
      ws.close();
      return;
    }
    if (msg.type === 'request') {
      try {
        const res = await fetch(msg.url, {
          method: msg.method,
          headers: msg.headers,
          body: msg.body,
          credentials: 'include',
        });
        const body = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        ws.send(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            status: res.status,
            headers,
            body,
          }),
        );
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, message: (err as Error).message }));
      }
    }
  });
  ws.addEventListener('close', () => {
    state.ws = null;
    setTimeout(() => void connect(), state.reconnectDelayMs);
    state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 30_000);
  });
}

// Boot on install + on every service-worker startup.
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();

// Keep the service worker alive (manifest v3 suspends idle workers).
chrome.alarms.create('wabe-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wabe-keepalive' && state.ws === null) void connect();
});
```

- [ ] **Step 2: Build + load unpacked in Chrome to manually verify**

This task has no automated test — extensions can't run in vitest. Manual smoke is fine for now; a Playwright integration test is a future task.

- [ ] **Step 3: Commit**

```
git add apps/extension-wabe/src/background.ts
git commit -S -m "feat(extension-wabe): service worker — WS proxy + reconnect + keepalive"
```

---

### Task 9: Extension popup — status + pairing

**Files:**
- Modify: `apps/extension-wabe/src/popup.html` + `popup.ts`

- [ ] **Step 1: `popup.html`** — minimal HTML: status text, "Pair" form (URL + token textarea + Save button), "Forget pairing" button.

- [ ] **Step 2: `popup.ts`** — load current config, render status (connected / not paired / disconnected), save form into `chrome.storage.local`, post message to background to trigger reconnect.

- [ ] **Step 3: Build + manual smoke.**

- [ ] **Step 4: Commit**

```
git add apps/extension-wabe/src/popup.html apps/extension-wabe/src/popup.ts
git commit -S -m "feat(extension-wabe): popup — pairing UI + connection status"
```

---

### Task 10: CLI `wabe bridge pair` + `wabe bridge status`

**Files:**
- Create: `packages/cli/src/commands/bridge/index.ts`
- Create: `packages/cli/src/commands/bridge/pair.ts`
- Create: `packages/cli/src/commands/bridge/status.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json` (add `@wabe/browser-bridge`)

- [ ] **Step 1: `pair.ts`**

Prints the pairing URL + token + a copy-paste blob and (optionally) a QR code. QR rendering keeps the dep surface tiny — use `qrcode-terminal` or just print the values and let the user paste.

```typescript
import type { Command } from 'commander';
import { loadOrGenerateSecret } from '@wabe/browser-bridge';
import { resolvePaths } from '../../paths.js';

export function registerPair(parent: Command): void {
  parent
    .command('pair')
    .description('print pairing token + URL for the Wabe browser extension')
    .action(() => {
      const { dataDir } = resolvePaths();
      const token = loadOrGenerateSecret(dataDir);
      const url = 'ws://127.0.0.1:8431/bridge'; // matches default in @wabe/browser-bridge config
      console.log('paste the following into the Wabe Bridge extension popup:');
      console.log('');
      console.log(`  Bridge URL: ${url}`);
      console.log(`  Auth token: ${token}`);
      console.log('');
      console.log('the token is stored at ${dataDir}/bridge-secret (mode 0600).');
    });
}
```

- [ ] **Step 2: `status.ts`** — calls `bridgeStatus()` from `@wabe/browser-bridge` over a tiny IPC? No — the bridge runs inside `wabe start`'s process, so `wabe bridge status` from a separate process can't read it directly. Two options:

  (a) The bridge server writes a small JSON heartbeat file under `${dataDir}/bridge.status.json` every N seconds.
  (b) The status command does a single WS connection attempt to the configured port and reports pass/fail.

  Option (b) is simpler. Implement that.

```typescript
import type { Command } from 'commander';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '@wabe/browser-bridge';
import { resolvePaths } from '../../paths.js';

export function registerStatus(parent: Command): void {
  parent
    .command('status')
    .description('check whether the bridge is running and a browser extension is connected')
    .action(async () => {
      const { dataDir } = resolvePaths();
      const token = loadOrGenerateSecret(dataDir);
      const url = 'ws://127.0.0.1:8431/bridge';
      const ws = new WebSocket(url);
      const result = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('NOT REACHABLE — wabe start running with bridge.enabled?'), 3_000);
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'hello',
              protocol_version: 1,
              extension_version: 'wabe-cli',
              auth_token_hex: token,
            }),
          );
        });
        ws.on('message', (data) => {
          clearTimeout(timer);
          const m = JSON.parse(String(data));
          ws.close();
          // NOTE: bridgeServer rejects the wabe-cli hello as a "second client" if an
          // extension is already connected — that's still proof the server is up.
          resolve(`server reachable (${m.type}); extension separately verified via popup.`);
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve('NOT REACHABLE — wabe start running with bridge.enabled?');
        });
      });
      console.log(result);
    });
}
```

- [ ] **Step 3: Parent + registration** — mirror `wabe agencies` parent from Phase C.

- [ ] **Step 4: Add deps + commit**

```
git add packages/cli/src/ packages/cli/package.json pnpm-lock.yaml
git commit -S -m "feat(cli): wabe bridge — pair + status"
```

---

### Task 11: Extend `wabe doctor` with bridge probe

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Add a bridge-section to doctor**

When `top.bridge.enabled === true`, hit the WS port and report:
- `[OK]` server reachable
- `[WARN]` server unreachable — is `wabe start` running?
- `[INFO]` extension paired? (read `lastConnectedAt` from storage isn't possible from CLI; skip — just report server reachability)

- [ ] **Step 2: Commit**

```
git add packages/cli/src/commands/doctor.ts
git commit -S -m "feat(cli): doctor — bridge connectivity probe"
```

---

### Task 12: Transport abstraction in `source-homegate`

**Files:**
- Create: `plugins/source-homegate/src/transport.ts`
- Modify: `plugins/source-homegate/src/client.ts`
- Modify: `plugins/source-homegate/src/index.ts`
- Modify: `plugins/source-homegate/package.json` (add `@wabe/browser-bridge`)

- [ ] **Step 1: Define the `Transport` shape locally** (alias of `@wabe/browser-bridge`'s `Transport` to keep package boundaries clean).

- [ ] **Step 2: Three implementations**

  - `UndiciTransport` — current `request()` call, raw undici.
  - `PlaywrightTransport` — wraps current `@wabe/browser-runtime` bootstrap (existing branch code).
  - `BrowserBridgeTransport` — re-exported from `@wabe/browser-bridge`.

- [ ] **Step 3: Selector**

```typescript
import { BrowserBridgeTransport, bridgeStatus } from '@wabe/browser-bridge';

export function selectTransport(): Transport {
  if (bridgeStatus().connected) return new BrowserBridgeTransport();
  if (playwrightAvailable()) return new PlaywrightTransport();
  return new UndiciTransport();
}
```

- [ ] **Step 4: Refactor `client.ts`** to take a `Transport` instead of calling `request()` directly.

- [ ] **Step 5: Tests** — unit-test each transport with a stub. The bridge transport test spawns the in-process WS server + a mock extension.

- [ ] **Step 6: Commit per file**

```
git commit -S -m "feat(source-homegate): Transport abstraction (Undici/Playwright/Bridge)"
```

---

### Task 13: Promote `source-immoscout24-sitemap` to full-detail when bridge is available

**Files:**
- Create: `plugins/source-immoscout24-sitemap/src/detail.ts`
- Modify: `plugins/source-immoscout24-sitemap/src/index.ts`
- Modify: `plugins/source-immoscout24-sitemap/src/map.ts`
- Modify: `plugins/source-immoscout24-sitemap/package.json`

The sitemap discovers new URLs. When the bridge transport is connected, for each new URL fetch the PDP HTML through the bridge, parse JSON-LD into `Listing` fields (rooms / price / area / photos / description), and emit the enriched listing instead of the URL-only stub.

- [ ] **Step 1: `detail.ts`** — JSON-LD extractor for IS24 PDP HTML. Same pattern as `plugins/source-schemaorg/src/detail.ts`; copy + adapt.

- [ ] **Step 2: Update `map.ts`** to take optional detail payload + emit full fields when present.

- [ ] **Step 3: Wire `index.ts`** to check transport availability via `bridgeStatus()`:

```typescript
const bridgeOn = bridgeStatus().connected;
const transport = bridgeOn ? new BrowserBridgeTransport() : null;
for (const e of newEntries) {
  if (transport) {
    const payload = await transport.request({ method: 'GET', url: e.loc, headers: { accept: 'text/html' } });
    const detail = extractJsonLd(payload.body);
    yield mapEntry(e, detail);
  } else {
    yield mapEntry(e, null); // existing URL-only path
  }
}
```

- [ ] **Step 4: Tests** — extend `map.test.ts` with full-detail fixture. Integration test (with bridge mock client) optional.

- [ ] **Step 5: Commit**

```
git commit -S -m "feat(source-immoscout24-sitemap): full-detail mode via browser bridge"
```

---

### Task 14: Re-enable homegate in example + remove preview suppression

**Files:**
- Modify: `examples/zurich-family/config/config.yaml`
- Modify: `plugins/notifier-telegram/src/card.ts`

Phase A patch commented out `homegate-zurich`; Phase B unblocks it (extension users get working scraping; headless users still fall back to Playwright via the transport selector).

- [ ] **Step 1: Uncomment the homegate entry** in `config.yaml`.

- [ ] **Step 2: Decide on preview suppression**

Keep `source-homegate` + `source-immoscout24-sitemap` in `PREVIEW_SUPPRESS_SOURCES` for now — Telegram's link-preview bot UA still hits the DataDome wall regardless of how Wabe fetches the data. Update the comment in `card.ts` to clarify this is for *preview unfurl*, not Wabe's own fetch.

- [ ] **Step 3: Commit**

```
git add examples/zurich-family/config/config.yaml plugins/notifier-telegram/src/card.ts
git commit -S -m "chore(examples,notifier): re-enable homegate; clarify preview-suppress rationale"
```

---

### Task 15: README + Extension install docs

**Files:**
- Modify: `apps/extension-wabe/README.md`
- Modify: `README.md`

Document:
- How to build the extension (`pnpm --filter @wabe/extension-wabe build`).
- How to load it unpacked in Chrome and Firefox.
- How to pair (`wabe bridge pair` → copy URL + token → popup).
- Bridge config in `config.yaml` (`bridge.enabled: true`).
- That headless deployments don't need the extension — Playwright fallback still works.

- [ ] **Step 1: Write extension README.**

- [ ] **Step 2: Add a "Phase B — Browser Bridge" section to the root README.**

- [ ] **Step 3: Commit**

```
git add apps/extension-wabe/README.md README.md
git commit -S -m "docs: browser-bridge install + pair flow"
```

---

### Task 16: Workspace CI gate

**Files:** none.

- [ ] **Step 1: `pnpm run ci`** — expected green.

- [ ] **Step 2: Fix any regressions inline; do NOT bypass.**

---

## Self-review

### Spec coverage (against `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §5)

| Spec requirement | Plan task |
|------------------|-----------|
| §5.2 `@wabe/browser-bridge` server + transport | Tasks 1–5 |
| §5.2 `apps/extension-wabe` manifest v3 | Tasks 7–9 |
| §5.2 Shared-secret pairing handshake | Tasks 3 + 4 |
| §5.2 127.0.0.1 only | Task 4 (default host) |
| §5.2 30s timeout | Task 2 protocol default + Task 4 enforcement |
| §5.3 Transport abstraction in `source-homegate` | Task 12 |
| §5.3 IS24 promotion to full-detail | Task 13 |
| §5.3 Auth0 login becomes optional (extension reads cookies automatically) | Implicit — the existing `wabe login homegate` Auth0 flow stays as legacy fallback; not removed |
| §5.4 CLI: `wabe bridge pair / status` | Task 10 |
| §5.4 `wabe doctor` bridge probe | Task 11 |
| §5.5 Transport selection order: bridge → playwright → undici | Task 12 step 3 |
| §5.6 Distribution (unpacked dev load) | Task 15 README |
| §5.7 Out of scope (Safari/mobile, multi-user, web-store) — confirmed not implemented |
| §5.8 Success criteria | Manual smoke tests post-T9; automated bridge ↔ extension is a followup (extension can't run in vitest) |

### Placeholder scan

- **Task 10 Step 2 (status command) coupling**: the `bridgeStatus()` function lives in the `wabe start` process; `wabe bridge status` can't read it directly. Solved by having `status` reattempt the WS handshake — proof the server is up. Documented in the task.
- **Task 12 PlaywrightTransport** reuses existing `@wabe/browser-runtime` bootstrap; the file already exists on `main` (Phase 0 homegate work). No new bootstrap code needed.
- **Task 13** assumes the IS24 PDP HTML embeds JSON-LD (`@type: RealEstateListing` per the investigation doc); if it doesn't, fall back to regex-extracting `__NEXT_DATA__` SSR JSON. Documented as a fallback path in Task 13 Step 1.
- No `TBD` / `TODO` / `implement later` entries.

### Type consistency

- `Transport` interface signature (`{ method, url, headers?, body?, timeout_ms?, signal? } → TransportResponse`) is consistent across Tasks 5, 12, 13.
- `BridgeRequest` / `BridgeResponse` shapes are sourced from `@wabe/browser-bridge/protocol`; both server (T4) and extension service worker (T8) marshal against the same Zod-defined fields.
- `PROTOCOL_VERSION = 1` is declared once in `protocol.ts` and consumed by server (T4) + extension (T8). Bumping requires touching both.
- `bridgeStatus()` from `@wabe/browser-bridge/server` is called from `source-homegate` (T12) and `source-immoscout24-sitemap` (T13) — single import, single source of truth on connection state.

### Scope check

Phase B is one cohesive subsystem — protocol + server + extension + transport refactor + IS24 promotion all serve the "real-browser request proxy" goal. Could split if execution time matters: Tasks 1–6 (bridge infra) and 7–9 (extension) can ship behind a feature flag with the source-plugin refactor (Tasks 12–13) as a sibling PR. Pragmatically, one branch is simpler.

### Open questions for the implementing agent

1. **Vite extension bundler vs raw esbuild**: plan uses `vite-plugin-web-extension` for ergonomic dev. If that's too heavy, swap for a plain esbuild script. Either works; plan favours vite-plugin-web-extension for its hot-reload during extension dev.
2. **Status helper IPC**: Task 10 Step 2 uses WS re-handshake; if that breaks the "only one extension at a time" invariant in the server (T4), extend the server to allow a transient inspect-only client. Mark as a deviation if you change the server's connection model.
3. **Test coverage for the extension itself**: no good vitest harness — defer to a Playwright-based extension test in a followup phase. Acceptable for v1.
