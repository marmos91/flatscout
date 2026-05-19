import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrGenerateSecret } from '../src/secret.js';
import { type BridgeServer, newRequestId, startBridgeServer } from '../src/server.js';

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
    await new Promise<void>((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
    ext.send(
      JSON.stringify({ type: 'response', id: reqId, status: 200, headers: {}, body: '{}' }),
    );
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(bridge.status().inflight).toBe(0);
  });
});
