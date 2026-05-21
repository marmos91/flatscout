import { fetch } from 'undici';

/**
 * Domains that should never end up as agency candidates: real-estate portals
 * we already scrape via dedicated source plugins, plus generic CDN/asset hosts
 * that show up in `lister.logo_url` etc. Caller filters by host suffix.
 */
const PORTAL_OR_CDN_DOMAINS = [
  // portals
  'homegate.ch',
  'immoscout24.ch',
  'flatfox.ch',
  'realadvisor.ch',
  'immobilier.ch',
  'home.ch',
  'comparis.ch',
  'newhome.ch',
  'urbanhome.ch',
  'lookmove.ch',
  'erstbezug.ch',
  // social / generic
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'youtube.com',
  // CDN / asset hosts
  'cloudinary.com',
  'amazonaws.com',
  'googleapis.com',
  'cloudfront.net',
  'akamaihd.net',
];

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function isPortalOrCdn(host: string): boolean {
  return PORTAL_OR_CDN_DOMAINS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export type CandidateSource = 'lister-website' | 'ddg-from-legal-name' | 'pdp-url-mined';

export interface Candidate {
  /** Full URL we'll fingerprint. Always normalised to https + trailing slash. */
  website: string;
  /** Slugified host (no www., no tld split) — used as registry `id`. */
  id: string;
  /**
   * Provenance: which mining path produced this candidate.
   * `lister-website` and `pdp-url-mined` are pure DB scans;
   * `ddg-from-legal-name` is the heuristic legal-name → `.ch` domain
   * resolver (history note: an earlier impl scraped DDG; the slug is kept
   * for backward-compatible writer notes).
   */
  source: CandidateSource;
  /** When `source === 'ddg-from-legal-name'`, the original legal_name queried. */
  legal_name?: string;
}

function slugifyHost(host: string): string {
  // Strip leading www., strip tld, kebab-case the rest.
  const stripped = host.replace(/^www\./, '');
  const noTld = stripped.replace(/\.[a-z]{2,6}$/i, '');
  return noTld
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function normaliseToCandidate(
  rawUrl: string,
  source: Candidate['source'],
  legalName?: string,
): Candidate | null {
  let host: string | null = null;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  if (isPortalOrCdn(host)) return null;
  // Canonical URL — strip path/query, https.
  const website = `https://${host}/`;
  const id = slugifyHost(host);
  if (!id) return null;
  return { website, id, source, ...(legalName ? { legal_name: legalName } : {}) };
}

interface DiscoveryDb {
  prepare<T>(sql: string): { all(...params: unknown[]): T[] };
}

/**
 * Scan the SQLite store for distinct `enriched.lister.website` values that
 * aren't from a known portal/CDN, returning normalised candidate rows.
 */
export function fromListerWebsiteRows(db: DiscoveryDb): Candidate[] {
  const rows = db
    .prepare<{ w: string }>(
      "SELECT DISTINCT json_extract(payload, '$.enriched.lister.website') AS w FROM listings WHERE json_extract(payload, '$.enriched.lister.website') IS NOT NULL AND json_extract(payload, '$.enriched.lister.website') != ''",
    )
    .all();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (!r.w) continue;
    const c = normaliseToCandidate(r.w, 'lister-website');
    if (c) out.push(c);
  }
  return out;
}

/** SQL LIKE alternatives for new-build phrases across DE / IT / FR / EN. */
export const NEW_BUILD_LIKE_CLAUSES =
  "(json_extract(payload, '$.description') LIKE '%Erstbezug%' OR json_extract(payload, '$.description') LIKE '%Neubau%' OR json_extract(payload, '$.description') LIKE '%prima occupazione%' OR json_extract(payload, '$.description') LIKE '%première occupation%' OR json_extract(payload, '$.description') LIKE '%first occupancy%' OR json_extract(payload, '$.description') LIKE '%first-time occupancy%')";

const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const BARE_DOMAIN_RE = /(?:^|\s|[(\[])(www\.[a-z0-9][a-z0-9.\-]+\.(?:ch|com|li|de|fr|it))/gi;

/**
 * Extract every external URL from a listing's description + extra fields,
 * normalise to a Candidate, drop portal/CDN hosts. Used by Path B
 * (PDP-URL mining): developers often paste their project website link into
 * the description text even when the portal doesn't expose a structured
 * `lister.website` field.
 *
 * `bareDomains` toggles a secondary regex that catches `www.foo.ch` strings
 * not preceded by an http(s) scheme — common in portal-rendered descriptions
 * where hyperlinks are flattened to plain text.
 */
export function extractDescriptionUrls(
  description: string,
  opts: { bareDomains?: boolean } = {},
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const m of description.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const c = normaliseToCandidate(url, 'pdp-url-mined');
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  if (opts.bareDomains ?? true) {
    for (const m of description.matchAll(BARE_DOMAIN_RE)) {
      const url = `https://${m[1]?.replace(/^www\./, '')}/`;
      const c = normaliseToCandidate(url, 'pdp-url-mined');
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * Scan the local store for listing rows whose description contains new-build
 * phrases (Erstbezug / Neubau / prima occupazione / première occupation /
 * first occupancy) and harvest every external URL from each description into
 * a candidate. When `newBuildOnly` is false, the entire `description` column
 * is scanned regardless of phrase — broader, noisier.
 */
export function pdpUrlCandidates(
  db: DiscoveryDb,
  opts: { newBuildOnly?: boolean; limit?: number } = {},
): Candidate[] {
  const where = opts.newBuildOnly ? `WHERE ${NEW_BUILD_LIKE_CLAUSES}` : '';
  const limit = opts.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : '';
  const sql = `SELECT json_extract(payload, '$.description') AS d FROM listings ${where} ${limit}`;
  const rows = db.prepare<{ d: string | null }>(sql).all();
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (!r.d) continue;
    for (const c of extractDescriptionUrls(r.d)) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
  }
  return out;
}

/** Distinct `enriched.lister.legal_name` values not already in `knownIds`. */
export function distinctLegalNames(db: DiscoveryDb): string[] {
  const rows = db
    .prepare<{ n: string }>(
      "SELECT DISTINCT json_extract(payload, '$.enriched.lister.legal_name') AS n FROM listings WHERE json_extract(payload, '$.enriched.lister.legal_name') IS NOT NULL AND json_extract(payload, '$.enriched.lister.legal_name') != ''",
    )
    .all();
  return rows.map((r) => r.n).filter((n): n is string => Boolean(n));
}

// Common entity-form suffixes that don't belong in a domain.
const ENTITY_SUFFIXES = new Set([
  'ag',
  'gmbh',
  'sa',
  'sarl',
  'srl',
  'gbr',
  'kg',
  'co',
  'company',
  'inc',
  'llc',
  'ltd',
  'limited',
]);
// Generic real-estate words that often appear in legal names but rarely in the
// brand domain. Stripped before domain heuristics.
const RE_WORDS = new Set([
  'immobilien',
  'immobiliare',
  'immobilier',
  'immobilière',
  'immobile',
  'real',
  'estate',
  'group',
  'bewirtschaftung',
  'verwaltung',
  'verwaltungs',
  'verwaltungsag',
  'management',
  'invest',
  'investment',
  'investments',
  'partners',
  'service',
  'services',
  'consulting',
  'beratung',
  'beratungs',
]);

function tokenize(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '') // strip diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Produce ordered candidate `.ch` hosts from an agency's legal name. Most
 * specific guesses come first (e.g. `vimova-bewirtschaftung.ch`), then
 * progressively shorter slugs (`vimova.ch`). Caller HEAD-checks each in
 * order and stops at the first 2xx/3xx.
 */
export function candidateDomainsFromLegalName(name: string): string[] {
  const tokens = tokenize(name).filter((t) => !ENTITY_SUFFIXES.has(t));
  if (tokens.length === 0) return [];
  const meaningful = tokens.filter((t) => !RE_WORDS.has(t));
  const ordered: string[] = [];
  const push = (s: string) => {
    if (!s) return;
    const h = `${s}.ch`;
    if (!ordered.includes(h)) ordered.push(h);
  };
  // Most specific: all meaningful tokens kebab-joined.
  if (meaningful.length > 1) push(meaningful.join('-'));
  // Then: first two meaningful tokens.
  if (meaningful.length >= 2) push(`${meaningful[0]}-${meaningful[1]}`);
  // Then: first meaningful token only.
  if (meaningful[0]) push(meaningful[0]);
  // As a last resort, drop the RE-word filter and try first raw token.
  if (tokens[0]) push(tokens[0]);
  return ordered;
}

async function liveCheck(host: string, signal: AbortSignal): Promise<string | null> {
  const url = `https://${host}/`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 flatscout-discover/1',
        accept: 'text/html,*/*;q=0.8',
      },
    });
  } catch {
    return null;
  }
  // Accept any non-error status — many CH sites 200 with a Cloudflare interstitial
  // but the eventual fingerprint can still classify them as `custom`.
  if (res.status >= 200 && res.status < 500) return url;
  return null;
}

/**
 * Resolve an agency's legal name to its `.ch` website using a heuristic
 * domain ladder (most-specific kebab-case slug first, narrowing toward the
 * brand root). Each candidate is HEAD/GET-checked for liveness; the first
 * responding host wins.
 *
 * Returns null when none of the candidate domains responds. This is faster
 * and more deterministic than search-engine scraping (which DuckDuckGo and
 * the rest now actively block for non-browser clients).
 */
export async function resolveLegalNameToWebsite(name: string, signal: AbortSignal): Promise<string | null> {
  const candidates = candidateDomainsFromLegalName(name);
  for (const host of candidates) {
    if (signal.aborted) return null;
    if (isPortalOrCdn(host)) continue;
    const live = await liveCheck(host, signal);
    if (live) return live;
  }
  return null;
}
