import crypto from 'node:crypto';

/** Pinned to the iOS Homegate app version captured on 2026-05-18. */
export const USER_AGENT = 'ch.homegate.Homegate/15.62.0 (iPhone, iOS 26.4.2, Scale 3.00)';
/** App-version header (separate from UA — encodes iOS major code as `/23`). */
export const X_APP_VERSION = 'Homegate/15.62.0/iPhone/iOS/23';

/**
 * Generates an `X-App-Id` value: a uniform random decimal in `[0, 10^26)`.
 *
 * Matches the observed iOS-app behaviour: 25- or 26-digit decimal nonce,
 * regenerated per request, uncorrelated with timestamp / X-UDID / body.
 */
export function newXAppId(): string {
  const buf = crypto.randomBytes(12);
  const n = (buf.readBigUInt64BE() << 32n) | BigInt(buf.readUInt32BE(8));
  return (n % 10n ** 26n).toString(10);
}

export interface BuildHeadersInput {
  /** Full `Cookie:` header value (datadome + cf_bm + any auth cookies). */
  cookie: string;
  /**
   * UA to send. Must match the UA that issued the DataDome cookie — DataDome
   * binds cookies to (UA + IP + TLS fingerprint), so a mismatch yields 403.
   * Source the value from `BootstrapResult.userAgent` (the Chromium UA used
   * during the bootstrap session), NOT the iOS app's pinned UA.
   */
  userAgent: string;
  /** Optional bearer token. Only attached when present (anonymous search omits it). */
  bearer?: string | null;
  /** Whether to set `Content-Type: application/json` (true for POSTs with a body). */
  hasBody?: boolean;
}

/**
 * Assembles request headers that match the desktop-Chrome bootstrap session:
 * Chrome UA, browser-shaped Accept/Accept-Language, plus the bootstrapped
 * cookies. The iOS-app-specific headers (`X-UDID`, `X-App-Version`,
 * `X-App-Id`, `Priority`) are deliberately omitted because they're tied to
 * the iOS-app-issued DataDome cookie path, which we don't have.
 */
export function buildHeaders(input: BuildHeadersInput): Record<string, string> {
  // Accept-Encoding omitted on purpose: undici doesn't auto-decompress, and
  // server-side gzip turns error bodies into binary blobs in logs. Identity
  // encoding keeps responses readable; the request body is small.
  const h: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': input.userAgent,
    Origin: 'https://www.homegate.ch',
    Referer: 'https://www.homegate.ch/',
    Cookie: input.cookie,
  };
  if (input.hasBody) h['Content-Type'] = 'application/json';
  if (input.bearer) h.Authorization = `Bearer ${input.bearer}`;
  return h;
}
