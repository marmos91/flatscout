import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readHeartbeat } from './heartbeat.js';
import type { BridgeError, BridgeRequest, BridgeResponse, ServerReject, ServerWelcome } from './protocol.js';
import { PROTOCOL_VERSION } from './protocol.js';
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
    ws.on('error', () => {
      /* close will follow */
    });
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
      ws.once('open', () => {
        clearTimeout(t);
        resolve(true);
      });
      ws.once('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    if (!opened) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return null;
    }

    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        extension_version: 'flatscout-cli-requester',
        auth_token_hex: secret,
      }),
    );

    const welcome = await new Promise<ServerWelcome | ServerReject | null>((resolve) => {
      const t = setTimeout(() => resolve(null), WELCOME_TIMEOUT_MS);
      ws.once('message', (data) => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(String(data)));
        } catch {
          resolve(null);
        }
      });
    });
    if (!welcome || welcome.type !== 'welcome') {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    return new DaemonBridgeTransport(ws);
  }

  private onMessage(raw: WebSocket.RawData): void {
    let parsed: BridgeResponse | BridgeError;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
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
      ...(opts.read_state ? { read_state: opts.read_state } : {}),
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
      if (ifl.signal && ifl.onAbort) ifl.signal.removeEventListener('abort', ifl.onAbort);
      ifl.reject(new Error('daemon bridge transport closed by caller'));
    }
    this.inflight.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
