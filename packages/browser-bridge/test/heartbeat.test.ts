import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BridgeStatus, readHeartbeat, startHeartbeat } from '../src/heartbeat.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-heartbeat-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    connected: false,
    inflight: 0,
    port: 8431,
    last_seen_at: 0,
    ...overrides,
  };
}

describe('startHeartbeat', () => {
  it('writes the status file immediately', async () => {
    const stop = startHeartbeat(dir, () => fakeStatus({ connected: true, port: 9000 }));
    expect(existsSync(join(dir, 'bridge.status.json'))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, 'bridge.status.json'), 'utf8'));
    expect(parsed.connected).toBe(true);
    expect(parsed.port).toBe(9000);
    expect(typeof parsed.written_at).toBe('number');
    stop();
  });

  it('updates the file on a periodic tick', async () => {
    let counter = 0;
    const stop = startHeartbeat(dir, () => fakeStatus({ inflight: ++counter }), { intervalMs: 30 });
    const first = JSON.parse(readFileSync(join(dir, 'bridge.status.json'), 'utf8'));
    await new Promise((r) => setTimeout(r, 80));
    const later = JSON.parse(readFileSync(join(dir, 'bridge.status.json'), 'utf8'));
    expect(later.inflight).toBeGreaterThan(first.inflight);
    stop();
  });

  it('stops writing after stop() is called', async () => {
    let counter = 0;
    const stop = startHeartbeat(dir, () => fakeStatus({ inflight: ++counter }), { intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    const before = JSON.parse(readFileSync(join(dir, 'bridge.status.json'), 'utf8'));
    stop();
    await new Promise((r) => setTimeout(r, 100));
    const after = JSON.parse(readFileSync(join(dir, 'bridge.status.json'), 'utf8'));
    expect(after.inflight).toBe(before.inflight);
  });

  it('creates the data directory if it does not exist', () => {
    const nested = join(dir, 'nested/path');
    const stop = startHeartbeat(nested, () => fakeStatus({ port: 1234 }));
    expect(existsSync(join(nested, 'bridge.status.json'))).toBe(true);
    stop();
  });
});

describe('readHeartbeat', () => {
  it('returns null when no file exists', () => {
    expect(readHeartbeat(dir)).toBeNull();
  });

  it('returns a parsed heartbeat with freshness derived from written_at', () => {
    const stop = startHeartbeat(dir, () => fakeStatus({ connected: true, port: 8431 }));
    const hb = readHeartbeat(dir);
    expect(hb).not.toBeNull();
    expect(hb?.connected).toBe(true);
    expect(hb?.port).toBe(8431);
    expect(typeof hb?.age_ms).toBe('number');
    expect(hb!.age_ms).toBeGreaterThanOrEqual(0);
    stop();
  });

  it('returns null if the file is corrupted', () => {
    const stop = startHeartbeat(dir, () => fakeStatus());
    stop();
    // Corrupt the file
    writeFileSync(join(dir, 'bridge.status.json'), '{not json');
    expect(readHeartbeat(dir)).toBeNull();
  });
});
