import type { BridgeRequest, ReadStateRequest } from './protocol.js';
import { type BridgeServer, getCurrentBridge, newRequestId } from './server.js';

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TransportRequestInit {
  method: BridgeRequest['method'];
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  signal?: AbortSignal;
  /** Read JS state from an open tab matching `url`'s host instead of fetching. */
  read_state?: ReadStateRequest;
}

/**
 * Minimal transport surface shared by `UndiciTransport`, `PlaywrightTransport`,
 * and `BrowserBridgeTransport` (this file). Source plugins consume only this
 * interface — selection of concrete implementation happens at plugin init time.
 */
export interface Transport {
  request(opts: TransportRequestInit): Promise<TransportResponse>;
}

/**
 * Routes requests through the connected browser extension.
 *
 * If no explicit `BridgeServer` is passed, falls back to the module-level
 * `getCurrentBridge()` singleton (the one started by `wabe start`).
 */
export class BrowserBridgeTransport implements Transport {
  constructor(private readonly bridge?: BridgeServer) {}

  async request(opts: TransportRequestInit): Promise<TransportResponse> {
    if (opts.signal?.aborted) {
      throw new Error('aborted');
    }
    const bridge = this.bridge ?? getCurrentBridge();
    if (!bridge) {
      throw new Error('no bridge server is running in this process');
    }
    const req: BridgeRequest = {
      type: 'request',
      id: newRequestId(),
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      body: opts.body,
      timeout_ms: opts.timeout_ms ?? 30_000,
      ...(opts.read_state ? { read_state: opts.read_state } : {}),
    };
    const resp = await bridge.dispatch(req, { signal: opts.signal });
    return { status: resp.status, headers: resp.headers, body: resp.body };
  }
}
