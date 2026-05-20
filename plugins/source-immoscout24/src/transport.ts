import type { Logger } from 'pino';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type Transport as BridgeTransport,
} from '@wabe/browser-bridge';

export type TransportKind = 'bridge-inproc' | 'bridge-daemon';

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD';
  url: string;
  signal: AbortSignal;
  logger: Logger;
  timeoutMs?: number;
  /** Accept header. Defaults to HTML; pass 'application/json' for API calls. */
  accept?: string;
}

export interface TransportResponse {
  status: number;
  body: string;
}

export interface Transport {
  readonly kind: TransportKind;
  request(opts: TransportRequestOpts): Promise<TransportResponse>;
  close?(): Promise<void>;
}

export class IS24BridgeTransport implements Transport {
  constructor(
    readonly kind: TransportKind,
    private readonly inner: BridgeTransport,
    private readonly onClose?: () => Promise<void>,
  ) {}

  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: { accept: opts.accept ?? 'text/html,application/xhtml+xml' },
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

export async function selectTransport(opts: SelectTransportOpts): Promise<Transport> {
  const local = getCurrentBridge();
  if (local) {
    opts.logger.info('immoscout24: using in-process bridge transport');
    return new IS24BridgeTransport('bridge-inproc', new BrowserBridgeTransport(local));
  }
  const daemon = await DaemonBridgeTransport.tryConnect(opts.dataDir);
  if (daemon) {
    opts.logger.info('immoscout24: using daemon bridge transport (cross-process)');
    return new IS24BridgeTransport('bridge-daemon', daemon, async () => {
      await daemon.close();
    });
  }
  throw new Error(
    'source-immoscout24 requires the Wabe browser bridge. ' +
      'Start `wabe start` with the extension paired, or run `wabe bridge pair` to set it up.',
  );
}
