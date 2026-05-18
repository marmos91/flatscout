import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeStatus } from './server.js';

export type { BridgeStatus };

const HEARTBEAT_FILE = 'bridge.status.json';
const DEFAULT_INTERVAL_MS = 5_000;

export interface HeartbeatOptions {
  /** How often to rewrite the heartbeat file. Default 5000ms. */
  intervalMs?: number;
}

export interface HeartbeatRead extends BridgeStatus {
  /** Epoch ms when the file was last written. */
  written_at: number;
  /** ms since written_at. Stale-detection lives in the caller (typically > 15s = stale). */
  age_ms: number;
}

/**
 * Starts writing the bridge status to `${dataDir}/bridge.status.json` on a periodic tick.
 *
 * Writes once immediately, then every `intervalMs`. Returns a `stop()` function.
 *
 * The file is read by `wabe bridge status` and `wabe doctor` — those run in a
 * separate process from `wabe start`, so the heartbeat file is the IPC primitive.
 */
export function startHeartbeat(
  dataDir: string,
  getStatus: () => BridgeStatus,
  opts: HeartbeatOptions = {},
): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, HEARTBEAT_FILE);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const write = (): void => {
    const status = getStatus();
    const payload = { ...status, written_at: Date.now() };
    writeFileSync(path, JSON.stringify(payload));
  };

  write();
  const timer = setInterval(write, intervalMs);
  // Don't keep the event loop alive solely on this timer.
  timer.unref?.();

  return (): void => {
    clearInterval(timer);
  };
}

/**
 * Reads the heartbeat file. Returns null if missing or corrupted.
 *
 * Callers should check `age_ms` against a threshold (e.g. 15_000) to detect stale heartbeats
 * from a crashed `wabe start` process.
 */
export function readHeartbeat(dataDir: string): HeartbeatRead | null {
  const path = join(dataDir, HEARTBEAT_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HeartbeatRead> & { written_at?: number };
    if (
      typeof parsed.written_at !== 'number' ||
      typeof parsed.connected !== 'boolean' ||
      typeof parsed.port !== 'number'
    ) {
      return null;
    }
    return {
      connected: parsed.connected,
      inflight: parsed.inflight ?? 0,
      port: parsed.port,
      last_seen_at: parsed.last_seen_at ?? 0,
      written_at: parsed.written_at,
      age_ms: Math.max(0, Date.now() - parsed.written_at),
    };
  } catch {
    return null;
  }
}
