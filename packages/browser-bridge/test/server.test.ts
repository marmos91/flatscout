import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '../src/secret.js';
import { startBridgeServer, type BridgeServer } from '../src/server.js';
import type { BridgeRequest, BridgeResponse } from '../src/protocol.js';

let dir: string;
let bridge: BridgeServer;
let port: number;
let secret: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-srv-'));
  secret = loadOrGenerateSecret(dir);
  bridge = await startBridgeServer({ dataDir: dir, port: 0 });
  port = bridge.port;
});

afterEach(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

function client(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/bridge`);
}

async function open(ws: WebSocket): Promise<void> {
  await new Promise<void>((r, reject) => {
    ws.once('open', () => r());
    ws.once('error', reject);
  });
}

function next(ws: WebSocket): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data))));
  });
}

async function hello(ws: WebSocket, token = secret): Promise<unknown> {
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: 1,
      extension_version: '0.0.0',
      auth_token_hex: token,
    }),
  );
  return next(ws);
}

describe('startBridgeServer handshake', () => {
  it('accepts a hello with the correct secret', async () => {
    const ws = client();
    await open(ws);
    const reply = (await hello(ws)) as { type: string };
    expect(reply.type).toBe('welcome');
    ws.close();
  });
  it('rejects a hello with a wrong-but-well-formed secret', async () => {
    const ws = client();
    await open(ws);
    const reply = (await hello(ws, 'b'.repeat(64))) as { type: string; reason: string };
    expect(reply.type).toBe('reject');
    expect(reply.reason).toMatch(/token/);
    ws.close();
  });
  it('rejects a malformed hello payload', async () => {
    const ws = client();
    await open(ws);
    ws.send(JSON.stringify({ type: 'hello', protocol_version: 1 }));
    const reply = (await next(ws)) as { type: string };
    expect(reply.type).toBe('reject');
    ws.close();
  });
  it('rejects bad JSON', async () => {
    const ws = client();
    await open(ws);
    ws.send('not json at all');
    const reply = (await next(ws)) as { type: string };
    expect(reply.type).toBe('reject');
    ws.close();
  });
});

describe('startBridgeServer request routing', () => {
  it('round-trips dispatch() → BridgeResponse via the connected client', async () => {
    const ws = client();
    await open(ws);
    await hello(ws);
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
    const req: BridgeRequest = {
      type: 'request',
      id: 'x-1',
      method: 'GET',
      url: 'https://example.test/path',
      headers: {},
      timeout_ms: 5_000,
    };
    const resp = await bridge.dispatch(req);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('{"echo":true}');
    ws.close();
  });

  it('propagates client-side error envelopes as rejections', async () => {
    const ws = client();
    await open(ws);
    await hello(ws);
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; id?: string };
      if (m.type === 'request') {
        ws.send(JSON.stringify({ type: 'error', id: m.id, message: 'fetch failed' }));
      }
    });
    await expect(
      bridge.dispatch({
        type: 'request',
        id: 'x-err',
        method: 'GET',
        url: 'https://example.test/',
        headers: {},
        timeout_ms: 5_000,
      }),
    ).rejects.toThrow(/fetch failed/);
    ws.close();
  });

  it('times out when no response arrives', async () => {
    const ws = client();
    await open(ws);
    await hello(ws);
    // do not register any message handler — server will time out
    await expect(
      bridge.dispatch({
        type: 'request',
        id: 'x-timeout',
        method: 'GET',
        url: 'https://example.test/',
        headers: {},
        timeout_ms: 100,
      }),
    ).rejects.toThrow(/timed out/);
    ws.close();
  });

  it('throws when no extension is connected', async () => {
    await expect(
      bridge.dispatch({
        type: 'request',
        id: 'x-no-ext',
        method: 'GET',
        url: 'https://example.test/',
        headers: {},
        timeout_ms: 1_000,
      }),
    ).rejects.toThrow(/not connected/);
  });
});

describe('startBridgeServer status', () => {
  it('reports disconnected when no extension is paired', () => {
    expect(bridge.status().connected).toBe(false);
  });
  it('reports connected after a successful hello', async () => {
    const ws = client();
    await open(ws);
    await hello(ws);
    expect(bridge.status().connected).toBe(true);
    ws.close();
    // Give the close event one tick to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.status().connected).toBe(false);
  });

  it('bumps last_seen_at on a post-handshake ping (unknown message type)', async () => {
    const ws = client();
    await open(ws);
    await hello(ws);
    const baseline = bridge.status().last_seen_at;
    // Wait one ms tick so the next bump is observably later than the hello bump.
    await new Promise((r) => setTimeout(r, 5));
    // The extension's in-page setInterval sends {type:'ping'} as a keepalive.
    // Unknown message types must still refresh last_seen_at; the daemon parses
    // after bumping so the heartbeat continues to register even if the schema
    // were to evolve.
    ws.send(JSON.stringify({ type: 'ping' }));
    // Give the server a tick to process.
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.status().last_seen_at).toBeGreaterThan(baseline);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('startBridgeServer tab overrides', () => {
  it('includes registered tab overrides in welcome', async () => {
    bridge.registerTabOverride({
      origin: 'https://api.agency-foo.ch',
      homepage: 'https://agency-foo.ch/listings',
      prewarm: ['https://api.agency-foo.ch/geo'],
    });
    const ws = client();
    await open(ws);
    const reply = (await hello(ws)) as {
      type: string;
      tab_overrides?: Array<{ origin: string; homepage: string; prewarm?: string[] }>;
    };
    expect(reply.type).toBe('welcome');
    expect(reply.tab_overrides).toHaveLength(1);
    expect(reply.tab_overrides?.[0]?.origin).toBe('https://api.agency-foo.ch');
    expect(reply.tab_overrides?.[0]?.prewarm).toEqual(['https://api.agency-foo.ch/geo']);
    ws.close();
  });

  it('pushes a heartbeat with the updated tab override list on new registration', async () => {
    const ws = client();
    await open(ws);
    await hello(ws); // consume welcome
    // Wait for a heartbeat triggered by the registration.
    const heartbeatP = new Promise<{
      type: string;
      tab_overrides?: Array<{ origin: string }>;
    }>((resolve) => {
      const onMsg = (data: WebSocket.RawData): void => {
        const m = JSON.parse(String(data)) as { type: string };
        if (m.type === 'heartbeat') {
          ws.off('message', onMsg);
          resolve(m as { type: string; tab_overrides?: Array<{ origin: string }> });
        }
      };
      ws.on('message', onMsg);
    });
    bridge.registerTabOverride({
      origin: 'https://api.agency-bar.ch',
      homepage: 'https://agency-bar.ch/',
    });
    const heartbeat = await heartbeatP;
    expect(heartbeat.tab_overrides?.some((o) => o.origin === 'https://api.agency-bar.ch')).toBe(true);
    ws.close();
  });
});

describe('startBridgeServer loopback enforcement', () => {
  it('always binds 127.0.0.1 even when StartOpts has no host field', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wabe-bridge-loopback-'));
    const b = await startBridgeServer({ dataDir: tmp, port: 0 });
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
    type Opts = Parameters<typeof startBridgeServer>[0];
    type HasHost = 'host' extends keyof Opts ? true : false;
    const _proof: HasHost = false;
    expect(_proof).toBe(false);
  });
});
