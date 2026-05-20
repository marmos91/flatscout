import { fetch } from 'undici';
import {
  type Candidate,
  isPortalOrCdn,
  normaliseToCandidate,
} from './candidates.js';

const HREF_RE = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;

/** Hosts we never want to mine even if they appear in a seed page — news/aggregator sites. */
const SEED_BLOCKLIST = [
  // generic news / aggregators / social — never agency homepages
  'nzz.ch',
  'tagesanzeiger.ch',
  'srf.ch',
  'blick.ch',
  '20min.ch',
  'wikipedia.org',
  'github.com',
  'medium.com',
  // additional aggregator portals beyond the core list in candidates.ts
  'bauinserate.ch',
  'baublatt.ch',
  'hochbau.ch',
  'archi-mag.com',
  'e-architect.com',
];

function isSeedBlocked(host: string): boolean {
  return SEED_BLOCKLIST.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * Fetch one external seed URL (news page, list page, blog post) and extract
 * every outgoing `<a href>` host that isn't a portal/CDN/news aggregator.
 *
 * Returns Candidate rows ready for the same fingerprint pipeline as the
 * DB-mined paths. Errors swallowed by the caller via `external-seeds.crawlAll`
 * — a single dead seed must not abort discovery.
 */
export async function crawlSeed(url: string, signal: AbortSignal): Promise<Candidate[]> {
  const res = await fetch(url, {
    signal,
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 wabe-discover/1',
      accept: 'text/html,*/*;q=0.8',
    },
  });
  if (res.status !== 200) return [];
  const html = await res.text();
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let seedHost: string | null = null;
  try {
    seedHost = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    seedHost = null;
  }
  for (const m of html.matchAll(HREF_RE)) {
    let href = m[1] ?? '';
    if (!href) continue;
    // Absolutise relative hrefs against the seed URL.
    try {
      href = new URL(href, url).toString();
    } catch {
      continue;
    }
    let host: string;
    try {
      host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }
    // Skip self-links and seed-list-blocked hosts.
    if (seedHost && host === seedHost) continue;
    if (isSeedBlocked(host)) continue;
    if (isPortalOrCdn(host)) continue;
    const c = normaliseToCandidate(href, 'pdp-url-mined');
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Crawl every seed URL in `seeds` and merge their candidates into one list.
 * Each seed's failures are isolated so one broken page never kills the run.
 */
export async function crawlAllSeeds(
  seeds: string[],
  signal: AbortSignal,
  log: (m: string) => void = () => {},
): Promise<Candidate[]> {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const seed of seeds) {
    if (signal.aborted) break;
    try {
      const got = await crawlSeed(seed, signal);
      let added = 0;
      for (const c of got) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
          added += 1;
        }
      }
      log(`seed ${seed}: ${added} new candidates`);
    } catch (err) {
      log(`seed ${seed}: error ${(err as Error).message}`);
    }
  }
  return out;
}
