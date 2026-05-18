import type { Logger } from 'pino';
import { request } from 'undici';
import {
  BrowserBridgeTransport as RawBridgeTransport,
  getCurrentBridge,
  readHeartbeat,
} from '@wabe/browser-bridge';
import { ensureBootstrap, type EnsureBootstrapOptions } from './bootstrap.js';
import { deleteCookies } from './cookies.js';
import { buildHeaders } from './headers.js';

const STALE_HEARTBEAT_MS = 15_000;

export type TransportKind = 'bridge' | 'playwright' | 'undici';

export interface TransportRequestOpts {
  method: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE';
  url: string;
  /** Whether the upstream payload is JSON (sets Content-Type when applicable). */
  hasBody: boolean;
  /** Stringified body (JSON or otherwise). */
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
 * Source-homegate's call-site contract. Each transport prepares its own
 * credentials (cookies + UA for Playwright; nothing for Bridge / Undici) and
 * issues the actual HTTPS request.
 */
export interface Transport {
  readonly kind: TransportKind;
  request(opts: TransportRequestOpts): Promise<TransportResponse>;
  /**
   * Called by the pagination loop on a 403 response. Implementations that own
   * credential state (Playwright) refresh it and return true so the caller can
   * retry once. Bridge / Undici return false.
   */
  invalidateAndRetryOnce(reason: string, logger: Logger): Promise<boolean>;
}

export interface PlaywrightTransportOpts {
  dataDir: string;
  cookieMaxAgeMs?: number;
  getBearer?: () => Promise<string | null>;
  ensureBootstrapFn?: typeof ensureBootstrap;
}

/**
 * Issues requests via the connected browser extension — credentials are
 * whatever the user's real Chrome/Firefox session attaches automatically.
 */
export class HomegateBridgeTransport implements Transport {
  readonly kind = 'bridge' as const;
  private readonly inner = new RawBridgeTransport();
  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const resp = await this.inner.request({
      method: opts.method,
      url: opts.url,
      headers: opts.hasBody ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: opts.body,
      timeout_ms: opts.timeoutMs,
      signal: opts.signal,
    });
    return { status: resp.status, body: resp.body };
  }
  async invalidateAndRetryOnce(): Promise<boolean> {
    // The bridge IS the user's real browser session — Wabe can't refresh
    // those cookies; the operator has to reload Homegate in their browser.
    return false;
  }
}

/**
 * Bootstraps cookies+UA via Playwright, then issues an undici request shaped
 * to match the captured Chromium session. This is the existing pre-Phase-B
 * path; preserved as a headless-deployment fallback.
 */
export class PlaywrightTransport implements Transport {
  readonly kind = 'playwright' as const;
  private cookieHeader = '';
  private userAgent = '';
  private bootstrapped = false;

  constructor(private readonly opts: PlaywrightTransportOpts) {}

  private async ensure(logger: Logger, force = false): Promise<void> {
    const ensureFn = this.opts.ensureBootstrapFn ?? ensureBootstrap;
    const opts: EnsureBootstrapOptions = { force };
    if (this.opts.cookieMaxAgeMs !== undefined) opts.maxAgeMs = this.opts.cookieMaxAgeMs;
    const cookies = await ensureFn(this.opts.dataDir, logger, opts);
    this.cookieHeader = cookies.cookieHeader;
    this.userAgent = cookies.userAgent;
    this.bootstrapped = true;
  }

  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    if (!this.bootstrapped) {
      await this.ensure(opts.logger);
    }
    const bearer = this.opts.getBearer ? await this.opts.getBearer() : null;
    const headers = buildHeaders({
      cookie: this.cookieHeader,
      userAgent: this.userAgent,
      bearer,
      hasBody: opts.hasBody,
    });
    const res = await request(opts.url, {
      method: opts.method,
      headers,
      body: opts.body,
      signal: opts.signal,
    });
    const body = await res.body.text();
    return { status: res.statusCode, body };
  }

  async invalidateAndRetryOnce(_reason: string, logger: Logger): Promise<boolean> {
    logger.warn('homegate 403 — invalidating cookies + re-bootstrapping');
    await deleteCookies(this.opts.dataDir);
    await this.ensure(logger, true);
    return true;
  }
}

/**
 * Raw undici with no cookies. Effectively anonymous against the public iOS API.
 * Last-resort fallback — Homegate likely 403s without a DataDome cookie, but
 * the path is exercised in tests and on hosts that have no browser at all.
 */
export class UndiciTransport implements Transport {
  readonly kind = 'undici' as const;
  async request(opts: TransportRequestOpts): Promise<TransportResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.hasBody) headers['content-type'] = 'application/json';
    const res = await request(opts.url, {
      method: opts.method,
      headers,
      body: opts.body,
      signal: opts.signal,
    });
    const body = await res.body.text();
    return { status: res.statusCode, body };
  }
  async invalidateAndRetryOnce(): Promise<boolean> {
    return false;
  }
}

export interface SelectTransportOpts extends PlaywrightTransportOpts {
  logger: Logger;
  /** When false, skips heartbeat lookup (e.g. tests that wire their own bridge). */
  checkHeartbeat?: boolean;
}

/**
 * Picks a transport at plugin-init time:
 *   1. `BrowserBridgeTransport` if a paired extension is connected (current
 *      process or fresh-enough heartbeat from a sibling `wabe start`).
 *   2. `PlaywrightTransport` if `@wabe/browser-runtime` is installed.
 *   3. `UndiciTransport` as last-resort fallback.
 *
 * Selection is one-shot for the plugin lifetime; reconnecting an extension
 * mid-run does not re-route ongoing scans.
 */
export function selectTransport(opts: SelectTransportOpts): Transport {
  if (isBridgeAvailable(opts.dataDir, opts.checkHeartbeat ?? true)) {
    opts.logger.info('homegate: using browser-bridge transport (paired extension)');
    return new HomegateBridgeTransport();
  }
  // PlaywrightTransport is the historical default; @wabe/browser-runtime is a
  // direct dependency of source-homegate so it is always resolvable.
  opts.logger.info('homegate: using playwright transport (no bridge connected)');
  return new PlaywrightTransport(opts);
}

function isBridgeAvailable(dataDir: string, checkHeartbeat: boolean): boolean {
  const inProc = getCurrentBridge();
  if (inProc && inProc.status().connected) return true;
  if (!checkHeartbeat) return false;
  const hb = readHeartbeat(dataDir);
  if (!hb) return false;
  if (hb.age_ms > STALE_HEARTBEAT_MS) return false;
  return hb.connected;
}
