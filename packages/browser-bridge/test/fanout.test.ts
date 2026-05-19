import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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
    await expect(
      new Promise<void>((_resolve, reject) => {
        w.once('open', () => reject(new Error('should not have opened')));
        w.once('error', () => reject(new Error('error')));
        w.once('close', () => reject(new Error('closed')));
      }),
    ).rejects.toBeDefined();
  });
});
