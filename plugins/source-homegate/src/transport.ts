import type { Logger } from 'pino';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type Transport as BridgeTransport,
} from '@wabe/browser-bridge';

export type TransportKind = 'bridge-inproc' | 'bridge-daemon';

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE';
  url: string;
  /** Whether the upstream payload is JSON (sets Content-Type when applicable). */
  hasBody: boolean;
  body?: string;
  signal: AbortSignal;
  logger: Logger;
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

/**
 * Source-homegate's call-site contract. Implementations are bridge-backed —
 * DataDome's challenge requires requests originate from a real page context.
 */
export interface Transport {
  readonly kind: TransportKind;
  request(opts: TransportRequestOpts): Promise<TransportResponse>;
  /** Release any held resources (e.g. daemon WS). Optional. */
  close?(): Promise<void>;
}

export class HomegateBridgeTransport implements Transport {
  constructor(
    readonly kind: TransportKind,
    private readonly inner: BridgeTransport,
    private readonly onClose?: () => Promise<void>,
  ) {}

  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: opts.hasBody
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: opts.body,
      timeout_ms: opts.timeoutMs,
      signal: opts.signal,
    });
    return { status: resp.status, body: resp.body };
  }

  async close(): Promise<void> {
    if (this.onClose) await this.onClose();
  }
}

export interface SelectTransportOpts {
  dataDir: string;
  logger: Logger;
}

/**
 * Selects a bridge transport at plugin init:
 *   1. `BrowserBridgeTransport` if `wabe start`'s in-process bridge is paired.
 *   2. `DaemonBridgeTransport` if a sibling `wabe start` daemon is running and
 *      reachable via `${dataDir}/bridge.status.json`.
 *
 * If neither path is available the plugin throws — DataDome blocks all other
 * transports, so there's no useful fallback.
 */
export async function selectTransport(opts: SelectTransportOpts): Promise<Transport> {
  const local = getCurrentBridge();
  if (local) {
    opts.logger.info('homegate: using in-process bridge transport');
    return new HomegateBridgeTransport('bridge-inproc', new BrowserBridgeTransport(local));
  }
  const daemon = await DaemonBridgeTransport.tryConnect(opts.dataDir);
  if (daemon) {
    opts.logger.info('homegate: using daemon bridge transport (cross-process)');
    return new HomegateBridgeTransport('bridge-daemon', daemon, async () => {
      await daemon.close();
    });
  }
  throw new Error(
    'source-homegate requires the Wabe browser bridge. ' +
      'Start `wabe start` with the extension paired, or run `wabe bridge pair` to set it up.',
  );
}
