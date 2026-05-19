import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DaemonBridgeTransport } from '../src/daemon-transport.js';
import { loadOrGenerateSecret } from '../src/secret.js';
import { type BridgeServer, startBridgeServer } from '../src/server.js';

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
    let opened = false;
    await new Promise<void>((resolve) => {
      w.once('open', () => {
        opened = true;
        resolve();
      });
      w.once('error', () => resolve());
      w.once('close', () => resolve());
    });
    expect(opened).toBe(false);
    expect(w.readyState).toBe(WebSocket.CLOSED);
  });
});

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

  it('replies with error envelope on malformed request payload', async () => {
    await pairExtension();
    const r = await pairRequester();
    r.send(JSON.stringify({ type: 'request', id: 'malformed', method: 'INVALID', url: 'not-a-url' }));
    const msg = (await recvJson(r, (m) => (m as { id?: string }).id === 'malformed')) as {
      type: string;
      message?: string;
    };
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/bad request/i);
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
    ext.send(JSON.stringify({ type: 'response', id: 'orphan', status: 200, headers: {}, body: '' }));
  });
});

describe('DaemonBridgeTransport', () => {
  it('connects on /dispatch and round-trips a request', async () => {
    const ext = await pairExtension();
    ext.on('message', (raw) => {
      const p = JSON.parse(String(raw)) as Partial<BridgeRequest>;
      if (p.type !== 'request') return;
      ext.send(JSON.stringify({ type: 'response', id: p.id, status: 200, headers: { x: 'y' }, body: 'hi' }));
    });
    const status = {
      connected: true,
      inflight: 0,
      port,
      last_seen_at: Date.now(),
      written_at: Date.now(),
    };
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
