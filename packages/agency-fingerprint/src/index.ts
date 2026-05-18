import { request } from 'undici';
import { HEURISTICS, type Platform, type HeuristicInput } from './heuristics.js';

export interface FingerprintResult {
  platform: Platform;
  /** Probed URL (post-redirect canonical). */
  url: string;
  /** Probed HTTP status. */
  status: number;
  /** Free-form note that explains *why* this platform was chosen (debug aid). */
  reason: string;
}

/**
 * Fetches a single HTML page and classifies its underlying platform.
 *
 * Returns `custom` when no heuristic matches — caller decides what to do
 * (typically: skip the agency until a family adapter exists, or rely on the
 * schema.org adapter if some JSON-LD is present but doesn't match its
 * narrower regex).
 */
export async function fingerprint(url: string, signal: AbortSignal): Promise<FingerprintResult> {
  const res = await request(url, {
    method: 'GET',
    signal,
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 wabe-fingerprint/0' },
  });
  const html = await res.body.text();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
  const input: HeuristicInput = { html, url, headers };
  for (const h of HEURISTICS) {
    if (h.test(input)) return { platform: h.platform, url, status: res.statusCode, reason: `matched heuristic: ${h.platform}` };
  }
  return { platform: 'custom', url, status: res.statusCode, reason: 'no heuristic matched' };
}

export { type Platform } from './heuristics.js';
