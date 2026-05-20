import { fetch } from 'undici';
import { HEURISTICS, type Platform, type HeuristicInput } from './heuristics.js';

export interface FingerprintResult {
  platform: Platform;
  /** Probed URL (post-redirect canonical when known, else the original). */
  url: string;
  /** Probed HTTP status. */
  status: number;
  /** Free-form note that explains *why* this platform was chosen (debug aid). */
  reason: string;
  /**
   * URL of the page that produced the matching heuristic — homepage URL when
   * the homepage matched, a sampled sitemap detail URL when the detail-probe
   * branch fired. Present even when `platform === 'custom'` to aid debugging.
   */
  matched_url?: string;
  /** Sitemap URL discovered during probing, if any. */
  sitemap_url?: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 wabe-fingerprint/1';

interface FetchOutcome {
  html: string;
  status: number;
  headers: Record<string, string>;
}

async function fetchHtml(url: string, signal: AbortSignal): Promise<FetchOutcome> {
  // undici's `fetch` follows redirects by default and exposes `response.url`,
  // which `request()` does not (its `maxRedirections` option was dropped in
  // undici 6.x in favor of the explicit redirect interceptor). Tests using
  // MockAgent route through this same global dispatcher.
  const res = await fetch(url, {
    method: 'GET',
    signal,
    redirect: 'follow',
    headers: { accept: 'text/html,application/xml,*/*;q=0.8', 'user-agent': UA },
  });
  const html = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { html, status: res.status, headers };
}

function classify(html: string, url: string, headers: Record<string, string>): Platform | null {
  const input: HeuristicInput = { html, url, headers };
  for (const h of HEURISTICS) if (h.test(input)) return h.platform;
  return null;
}

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml'];
// Strong hints — paths that almost always correspond to per-object detail
// pages or sitemaps of them. Tried first.
const STRONG_DETAIL_RE =
  /(objekt|object|listing|inserat|immobilie|immobilien|wohnung|apartment|haus|exposé|expose|property)/i;
// Weak hints — match category/landing pages too, so used only as a fallback
// when nothing stronger is available.
const WEAK_DETAIL_RE = /(mieten|kaufen|verkauf|rent|sale|house|wohnen)/i;
// A path that looks like a listing detail rather than a category index — it
// either ends with a numeric id segment or carries a multi-word slug after
// the listing-typed segment.
const HAS_ID_SEGMENT_RE = /\/[a-z0-9-]*\d{2,}(?:[a-z0-9-]*)?\/?$/i;
const LOC_RE = /<loc>([^<]+)<\/loc>/gi;

interface DiscoveredSitemap {
  url: string;
  xml: string;
}

async function discoverSitemap(base: URL, signal: AbortSignal): Promise<DiscoveredSitemap | null> {
  try {
    const robots = await fetchHtml(new URL('/robots.txt', base).toString(), signal);
    if (robots.status === 200) {
      const m = robots.html.match(/^\s*Sitemap:\s*(\S+)/im);
      if (m?.[1]) {
        try {
          const r = await fetchHtml(m[1], signal);
          if (r.status === 200 && /<urlset|<sitemapindex/i.test(r.html)) return { url: m[1], xml: r.html };
        } catch {
          // fall through to default paths
        }
      }
    }
  } catch {
    // fall through
  }
  for (const p of SITEMAP_PATHS) {
    try {
      const candidate = new URL(p, base).toString();
      const res = await fetchHtml(candidate, signal);
      if (res.status === 200 && /<urlset|<sitemapindex/i.test(res.html))
        return { url: candidate, xml: res.html };
    } catch {
      // try next
    }
  }
  return null;
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(LOC_RE)) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

function scoreDetailUrl(u: string): number {
  // Higher score = more likely to be a per-object detail page.
  let score = 0;
  if (STRONG_DETAIL_RE.test(u)) score += 4;
  else if (WEAK_DETAIL_RE.test(u)) score += 1;
  if (HAS_ID_SEGMENT_RE.test(u)) score += 3;
  try {
    const segs = new URL(u).pathname.split('/').filter(Boolean);
    if (segs.length >= 3) score += 1; // deep paths bias toward detail
    const last = segs.at(-1) ?? '';
    if (last.length >= 10 && /-/.test(last)) score += 1; // long kebab slug
  } catch {
    // ignore unparseable URLs
  }
  return score;
}

/**
 * Pick a sample detail URL from a sitemap (or sitemap-index → child sitemap).
 * Walks at most a few levels of sitemap-index nesting and scores candidates
 * to prefer per-object detail pages over category/landing pages. The first
 * URL still wins as a last-resort fallback so we never return null when at
 * least one URL exists.
 */
async function sampleDetailUrl(start: DiscoveredSitemap, signal: AbortSignal): Promise<string | null> {
  let current = start;
  for (let depth = 0; depth < 3; depth++) {
    const locs = extractLocs(current.xml);
    if (locs.length === 0) return null;
    if (!/<sitemapindex/i.test(current.xml)) {
      const ranked = locs
        .map((u) => ({ u, s: scoreDetailUrl(u) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      return ranked[0]?.u ?? locs[0] ?? null;
    }
    const ranked = locs.map((u) => ({ u, s: scoreDetailUrl(u) })).sort((a, b) => b.s - a.s);
    const child = ranked[0]?.u ?? locs[0];
    if (!child) return null;
    try {
      const res = await fetchHtml(child, signal);
      if (res.status !== 200) return null;
      current = { url: child, xml: res.html };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fetches a single HTML page and classifies its underlying platform. When the
 * landing page is inconclusive, walks the agency's sitemap (or sitemap-index)
 * to sample one detail URL and re-runs heuristics on it — many agency sites
 * carry only Organization/WebPage JSON-LD on the homepage but emit
 * RealEstateListing JSON-LD on individual object pages.
 *
 * Returns `custom` when no heuristic matches the homepage or a sampled detail
 * page — caller decides what to do (typically: skip until a family adapter
 * exists, or hand-classify after eyeballing the site).
 */
export async function fingerprint(url: string, signal: AbortSignal): Promise<FingerprintResult> {
  const home = await fetchHtml(url, signal);
  const homePlatform = classify(home.html, url, home.headers);
  if (homePlatform) {
    return {
      platform: homePlatform,
      url,
      status: home.status,
      reason: `matched heuristic on homepage: ${homePlatform}`,
      matched_url: url,
    };
  }
  // Inconclusive on homepage — try sitemap-sampled detail probe.
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return { platform: 'custom', url, status: home.status, reason: 'invalid base URL' };
  }
  const sitemap = await discoverSitemap(base, signal);
  if (!sitemap) {
    return {
      platform: 'custom',
      url,
      status: home.status,
      reason: 'no heuristic matched on homepage and no sitemap discovered',
    };
  }
  let detailUrl: string | null = null;
  try {
    detailUrl = await sampleDetailUrl(sitemap, signal);
  } catch {
    // ignore — handled below
  }
  if (!detailUrl) {
    return {
      platform: 'custom',
      url,
      status: home.status,
      reason: `sitemap ${sitemap.url} produced no sample detail URL`,
      sitemap_url: sitemap.url,
    };
  }
  let detail: FetchOutcome;
  try {
    detail = await fetchHtml(detailUrl, signal);
  } catch (err) {
    return {
      platform: 'custom',
      url,
      status: home.status,
      reason: `detail fetch failed: ${(err as Error).message}`,
      sitemap_url: sitemap.url,
      matched_url: detailUrl,
    };
  }
  const detailPlatform = classify(detail.html, detailUrl, detail.headers);
  if (detailPlatform) {
    return {
      platform: detailPlatform,
      url,
      status: detail.status,
      reason: `matched heuristic on sampled detail page: ${detailPlatform}`,
      matched_url: detailUrl,
      sitemap_url: sitemap.url,
    };
  }
  return {
    platform: 'custom',
    url,
    status: detail.status,
    reason: 'no heuristic matched on homepage or sampled detail page',
    sitemap_url: sitemap.url,
    matched_url: detailUrl,
  };
}

export type { Platform } from './heuristics.js';
