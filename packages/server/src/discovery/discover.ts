import { fingerprint } from '@wabe/agency-fingerprint';
import type { AgencyEntry } from '@wabe/core';
import {
  type Candidate,
  distinctLegalNames,
  fromListerWebsiteRows,
  isPortalOrCdn,
  normaliseToCandidate,
  pdpUrlCandidates,
  resolveLegalNameToWebsite,
} from './candidates.js';
import { readDiscoveredRegistry, writeDiscoveredRegistry } from './registry-io.js';

export interface DiscoverOptions {
  /** Sqlite handle. Anything with `prepare(sql).all()` works. */
  db: { prepare<T>(sql: string): { all(...p: unknown[]): T[] } };
  /** Absolute path to the discovered-registry YAML file. */
  outFile: string;
  /** Hard cap on how many new probes a single run will perform. */
  maxNewProbes?: number;
  /** Sleep between candidate probes; lets us be polite to DDG + agency origins. */
  pacingMs?: number;
  /** When true, also resolve distinct `legal_name` values to `.ch` websites via the heuristic ladder. */
  resolveLegalNames?: boolean;
  /** When true, scan listing description text for external URLs (Path B). */
  mineDescriptionUrls?: boolean;
  /** Scope Path B to listings whose description carries a new-build phrase. */
  newBuildOnly?: boolean;
  /** Default canton tag for newly discovered rows. */
  defaultCanton?: AgencyEntry['canton'];
  /** Default `enabled` flag — false by default so user reviews before scanning. */
  enabledByDefault?: boolean;
  signal: AbortSignal;
  log?: (msg: string) => void;
}

export interface DiscoverSummary {
  total_candidates: number;
  already_known: number;
  probed: number;
  added: number;
  by_platform: Record<string, number>;
  skipped_no_resolve: number;
  errors: number;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

/**
 * Single-pass discovery: gather candidate websites from the DB, optionally
 * resolve legal_name → website via DuckDuckGo, fingerprint each new candidate,
 * and append registry rows to the discovered registry file. Returns a summary
 * so callers (CLI, pipeline hook) can log what happened.
 *
 * Idempotent across runs — rows already present in the discovered registry by
 * `id` are skipped without re-probing.
 */
export async function discoverAgencies(opts: DiscoverOptions): Promise<DiscoverSummary> {
  const {
    db,
    outFile,
    maxNewProbes = 25,
    pacingMs = 1500,
    resolveLegalNames = true,
    mineDescriptionUrls = true,
    newBuildOnly = false,
    defaultCanton = 'ZH',
    enabledByDefault = false,
    signal,
    log = () => {},
  } = opts;
  const summary: DiscoverSummary = {
    total_candidates: 0,
    already_known: 0,
    probed: 0,
    added: 0,
    by_platform: {},
    skipped_no_resolve: 0,
    errors: 0,
  };

  const { agencies: existingAgencies, knownIds } = readDiscoveredRegistry(outFile);

  // Path A.1 — direct lister.website rows in the DB.
  const direct = fromListerWebsiteRows(db);
  // Path A.2 — distinct legal_names → heuristic-ladder resolution.
  const legalNames = resolveLegalNames ? distinctLegalNames(db) : [];
  // Path B — scan listing descriptions for external URLs (new-build links etc.).
  const pdp = mineDescriptionUrls ? pdpUrlCandidates(db, { newBuildOnly }) : [];

  // Dedupe candidates by `id` before any expensive work.
  const byId = new Map<string, Candidate>();
  for (const c of direct) if (!byId.has(c.id)) byId.set(c.id, c);
  for (const c of pdp) if (!byId.has(c.id)) byId.set(c.id, c);
  summary.total_candidates = byId.size + legalNames.length;

  const newAgencies: AgencyEntry[] = [...existingAgencies];

  for (const candidate of byId.values()) {
    if (signal.aborted) break;
    if (knownIds.has(candidate.id)) {
      summary.already_known += 1;
      continue;
    }
    if (summary.probed >= maxNewProbes) break;
    const added = await probeAndAppend(candidate, newAgencies, knownIds, summary, signal, log);
    if (added) summary.added += 1;
    summary.probed += 1;
    await sleep(pacingMs, signal).catch(() => undefined);
  }

  // Then walk legal names — only those that don't already map to a known id.
  for (const name of legalNames) {
    if (signal.aborted) break;
    if (summary.probed >= maxNewProbes) break;
    let resolved: string | null = null;
    try {
      resolved = await resolveLegalNameToWebsite(name, signal);
    } catch {
      summary.errors += 1;
      continue;
    }
    if (!resolved) {
      summary.skipped_no_resolve += 1;
      continue;
    }
    const candidate = normaliseToCandidate(resolved, 'ddg-from-legal-name', name);
    if (!candidate) {
      summary.skipped_no_resolve += 1;
      continue;
    }
    if (knownIds.has(candidate.id)) {
      summary.already_known += 1;
      continue;
    }
    const added = await probeAndAppend(candidate, newAgencies, knownIds, summary, signal, log);
    if (added) summary.added += 1;
    summary.probed += 1;
    await sleep(pacingMs, signal).catch(() => undefined);
  }

  // Filter: drop platform === 'custom' rows that wouldn't be picked up by any
  // bundled adapter — they'd just clutter the file. Keep platforms we can
  // scan (schemaorg, casasoft, immomig, iframe-portal) and skip the rest.
  const enableableNew = newAgencies.filter((a, i) => {
    if (i < existingAgencies.length) return true; // keep existing rows untouched
    return ['schemaorg', 'casasoft', 'immomig'].includes(a.platform);
  });

  // Update the file only when we actually added something — avoids touching
  // the mtime on a no-op run.
  if (enableableNew.length > existingAgencies.length) {
    writeDiscoveredRegistry(outFile, enableableNew);
  }
  return summary;

  // ---------- inner helper ----------
  async function probeAndAppend(
    candidate: Candidate,
    list: AgencyEntry[],
    known: Set<string>,
    s: DiscoverSummary,
    sig: AbortSignal,
    logFn: (m: string) => void,
  ): Promise<boolean> {
    if (isPortalOrCdn(new URL(candidate.website).hostname.replace(/^www\./, ''))) return false;
    try {
      const fp = await fingerprint(candidate.website, sig);
      s.by_platform[fp.platform] = (s.by_platform[fp.platform] ?? 0) + 1;
      logFn(`probe ${candidate.id}: ${fp.platform} (${fp.reason})`);
      const entry: AgencyEntry = {
        id: candidate.id,
        name: candidate.legal_name ?? candidate.id,
        website: candidate.website,
        canton: defaultCanton,
        platform: fp.platform === 'iframe-portal' ? 'custom' : fp.platform,
        rate_limit_per_min: 6,
        priority: 100,
        enabled: enabledByDefault,
        notes: `discovered via ${candidate.source} on ${new Date().toISOString().slice(0, 10)}`,
      };
      list.push(entry);
      known.add(candidate.id);
      return true;
    } catch (err) {
      s.errors += 1;
      logFn(`probe ${candidate.id}: error ${(err as Error).message}`);
      return false;
    }
  }
}
