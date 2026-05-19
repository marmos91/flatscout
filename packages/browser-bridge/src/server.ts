import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  type BridgeRequest,
  type BridgeResponse,
  ClientHello,
  ClientMessage,
  PROTOCOL_VERSION,
} from './protocol.js';
import { loadOrGenerateSecret, validateToken } from './secret.js';

export interface StartOpts {
  dataDir: string;
  /** Pass 0 to let the OS pick a free port (used in tests). */
  port: number;
}

export interface BridgeStatus {
  connected: boolean;
  inflight: number;
  port: number;
  /** Epoch ms of the most recent extension activity (hello or response). 0 if never connected. */
  last_seen_at: number;
}

export interface BridgeServer {
  port: number;
  status(): BridgeStatus;
  dispatch(req: BridgeRequest, opts?: { signal?: AbortSignal }): Promise<BridgeResponse>;
  stop(): Promise<void>;
}

interface Inflight {
  resolve: (r: BridgeResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Module-level pointer to the most-recently-started bridge for plugin code that wants implicit access. */
let currentBridge: BridgeServer | null = null;

export function getCurrentBridge(): BridgeServer | null {
  return currentBridge;
}

export function newRequestId(): string {
  return randomUUID();
}

export async function startBridgeServer(opts: StartOpts): Promise<BridgeServer> {
  const secret = loadOrGenerateSecret(opts.dataDir);
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

  let activeSocket: WebSocket | null = null;
  let lastSeenAt = 0;
  const inflight = new Map<string, Inflight>();

  wss.on('connection', (ws, req) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    const role: 'extension' | 'requester' =
      (ws as WebSocket & { _path?: string })._path === '/dispatch' ? 'requester' : 'extension';
    if (process.env.WABE_BRIDGE_DEBUG)
      console.log(
        `[bridge] connect from ${peer} role=${role} ua=${req.headers['user-agent'] ?? 'n/a'}`,
      );
    if (role === 'requester') {
      let helloReceived = false;
      ws.on('message', (raw) => {
        if (!helloReceived) {
          try {
            const parsed = JSON.parse(String(raw));
            const hello = ClientHello.safeParse(parsed);
            if (!hello.success || !validateToken(secret, hello.data.auth_token_hex)) {
              ws.send(
                JSON.stringify({
                  type: 'reject',
                  reason: hello.success ? 'bad token' : 'bad hello',
                }),
              );
              ws.close();
              return;
            }
            helloReceived = true;
            ws.send(JSON.stringify({ type: 'welcome', protocol_version: PROTOCOL_VERSION }));
            return;
          } catch {
            ws.close();
          }
        }
        // post-hello requester messages are handled in Task 7.
      });
      ws.on('close', () => {});
      return;
    }
    let helloReceived = false;
    ws.on('message', (raw) => {
      if (process.env.WABE_BRIDGE_DEBUG)
        console.log(`[bridge] msg from ${peer}: ${String(raw).slice(0, 200)}`);
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
        lastSeenAt = Date.now();
        ws.send(JSON.stringify({ type: 'welcome', protocol_version: PROTOCOL_VERSION }));
        if (activeSocket && activeSocket !== ws && activeSocket.readyState === activeSocket.OPEN) {
          // Newer extension preempts older one — single-bridge-client invariant.
          activeSocket.close();
        }
        activeSocket = ws;
        return;
      }
      const msg = ClientMessage.safeParse(parsed);
      if (!msg.success) return;
      lastSeenAt = Date.now();
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
    ws.on('close', (code, reason) => {
      if (process.env.WABE_BRIDGE_DEBUG)
        console.log(`[bridge] close from ${peer} code=${code} reason=${reason.toString() || '(none)'}`);
      if (activeSocket === ws) activeSocket = null;
    });
    ws.on('error', (err) => {
      if (process.env.WABE_BRIDGE_DEBUG)
        console.log(`[bridge] error from ${peer}: ${(err as Error).message}`);
    });
  });

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

  function status(): BridgeStatus {
    return {
      connected: activeSocket !== null && activeSocket.readyState === activeSocket.OPEN,
      inflight: inflight.size,
      port,
      last_seen_at: lastSeenAt,
    };
  }

  async function stop(): Promise<void> {
    for (const ifl of inflight.values()) {
      clearTimeout(ifl.timer);
      ifl.reject(new Error('bridge server stopping'));
    }
    inflight.clear();
    if (activeSocket) {
      try {
        activeSocket.close();
      } catch {
        // ignore
      }
      activeSocket = null;
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
    });
    if (currentBridge === handle) currentBridge = null;
  }

  const handle: BridgeServer = { port, status, dispatch, stop };
  currentBridge = handle;
  return handle;
}
