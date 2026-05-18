import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '../src/secret.js';
import { startBridgeServer, type BridgeServer } from '../src/server.js';
import { BrowserBridgeTransport } from '../src/transport.js';

let dir: string;
let bridge: BridgeServer;
let secret: string;
let extWs: WebSocket;

async function open(ws: WebSocket): Promise<void> {
  await new Promise<void>((r, reject) => {
    ws.once('open', () => r());
    ws.once('error', reject);
  });
}

async function pairExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await open(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocol_version: 1,
      extension_version: '0.0.0',
      auth_token_hex: secret,
    }),
  );
  await new Promise<void>((resolve) => {
    ws.once('message', () => resolve());
  });
  return ws;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-bridge-transport-'));
  secret = loadOrGenerateSecret(dir);
  bridge = await startBridgeServer({ dataDir: dir, port: 0 });
  extWs = await pairExtension(bridge.port);
});

afterEach(async () => {
  try {
    extWs.close();
  } catch {
    // ignore
  }
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('BrowserBridgeTransport', () => {
  it('round-trips a GET request through the bridge', async () => {
    extWs.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; id?: string; url?: string };
      if (m.type === 'request') {
        extWs.send(
          JSON.stringify({
            type: 'response',
            id: m.id,
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: `echo:${m.url}`,
          }),
        );
      }
    });
    const t = new BrowserBridgeTransport(bridge);
    const resp = await t.request({
      method: 'GET',
      url: 'https://example.test/path?x=1',
      headers: { accept: 'text/plain' },
    });
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('echo:https://example.test/path?x=1');
    expect(resp.headers['content-type']).toBe('text/plain');
  });

  it('propagates aborts via AbortSignal before dispatch', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const t = new BrowserBridgeTransport(bridge);
    await expect(
      t.request({
        method: 'GET',
        url: 'https://example.test/',
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it('uses the explicit timeout when provided', async () => {
    const t = new BrowserBridgeTransport(bridge);
    await expect(
      t.request({
        method: 'GET',
        url: 'https://example.test/',
        timeout_ms: 80,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
