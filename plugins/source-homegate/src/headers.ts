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
  /** Stable per-install UUID — see install.ts. */
  xUdid: string;
  /** Optional bearer token. Only attached when present (anonymous search omits it). */
  bearer?: string | null;
  /** Whether to set `Content-Type: application/json` (true for POSTs with a body). */
  hasBody?: boolean;
}

/**
 * Assembles the full Homegate header set per the iOS capture. `X-App-Id` is
 * regenerated on every call. `Content-Type` is only set when `hasBody` is true
 * (the iOS app omits it on GETs). `Authorization` is only set when `bearer`
 * is present.
 */
export function buildHeaders(input: BuildHeadersInput): Record<string, string> {
  const h: Record<string, string> = {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': USER_AGENT,
    'X-App-Version': X_APP_VERSION,
    'X-UDID': input.xUdid,
    'X-App-Id': newXAppId(),
    Priority: 'u=3',
    Cookie: input.cookie,
  };
  if (input.hasBody) h['Content-Type'] = 'application/json';
  if (input.bearer) h.Authorization = `Bearer ${input.bearer}`;
  return h;
}
