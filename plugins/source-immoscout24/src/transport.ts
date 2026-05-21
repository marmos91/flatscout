import type { Logger } from 'pino';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type ReadStateAction,
  type Transport as BridgeTransport,
} from '@wabe/browser-bridge';

export type TransportKind = 'bridge-inproc' | 'bridge-daemon';

export type ReadStateActionInput =
  | { kind: 'eval'; js: string }
  | { kind: 'wait_for'; js_predicate: string; timeout_ms?: number; poll_ms?: number };

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD';
  url: string;
  signal: AbortSignal;
  logger: Logger;
  timeoutMs?: number;
  /** Accept header. Defaults to HTML; pass 'application/json' for API calls. */
  accept?: string;
  /**
   * Read JS state from a tab matching `url`'s host instead of fetching. Used
   * because IS24's SRP URL pattern only resolves to listings when emitted as
   * an internal SPA XHR; raw fetches get a DataDome challenge regardless of
   * cookie state. The plugin reads `window.__INITIAL_STATE__` from a tab the
   * user already has open at immoscout24.ch.
   *
   * Optional `actions` run in MAIN world before the state read — used to
   * drive SPA pagination in the tab without losing the DataDome session.
   */
  readState?: { jsPath: string; actions?: ReadStateActionInput[] };
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
    const readState = opts.readState
      ? {
          js_path: opts.readState.jsPath,
          // The wire schema applies defaults for wait_for timeout_ms/poll_ms,
          // so the inferred z.output type marks them required. Plugin callers
          // pass the input-shape (optionals); cast to bridge over the asymmetry.
          ...(opts.readState.actions
            ? { actions: opts.readState.actions as unknown as ReadStateAction[] }
            : {}),
        }
      : undefined;
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: { accept: opts.accept ?? 'text/html,application/xhtml+xml' },
      timeout_ms: opts.timeoutMs,
      signal: opts.signal,
      ...(readState ? { read_state: readState } : {}),
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
