import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { interpolateEnv, FiltersFile, RentalTermFile, type RentalTermPolicy, ScoringFile } from '@wabe/core';
import { parse as parseYaml } from 'yaml';
import { loadRegistry } from './agency-registry/loader.js';
import { expandRegistry, BUNDLED_ADAPTERS } from './agency-registry/expand.js';
import { verifySignature } from './agency-registry/verify.js';

/** A single entry in the top-level `enabled.{sources,scorers,notifiers,enrichers,applicators}` lists. */
export const EnabledEntry = z.object({
  name: z.string(),
  plugin: z.string(),
  config: z.string(),
});
export type EnabledEntry = z.infer<typeof EnabledEntry>;

/** Schema for the orchestrator's `config.yaml` (which plugins are enabled, plus log config). */
export const TopConfig = z.object({
  enabled: z.object({
    sources: z.array(EnabledEntry).default([]),
    scorers: z.array(EnabledEntry).default([]),
    notifiers: z.array(EnabledEntry).default([]),
    enrichers: z.array(EnabledEntry).default([]),
    applicators: z.array(EnabledEntry).default([]),
  }),
  log: z.object({ level: z.string().default('info') }).default({ level: 'info' }),
  /**
   * Optional browser-bridge daemon. When enabled, `wabe start` binds a
   * WebSocket server on 127.0.0.1:`port` (loopback is hard-enforced) so a
   * paired browser extension can proxy HTTPS requests on behalf of source
   * plugins.
   */
  bridge: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(8431),
    })
    .default({ enabled: false, port: 8431 }),
  /**
   * Auto-discovery of agency candidates from listings already in the local
   * store. After each scan cycle the daemon mines `lister.website` and
   * `lister.legal_name` for previously-unknown agencies, fingerprints each,
   * and appends to `${dataDir}/agencies.discovered.yaml`. Subsequent scans
   * load those discovered rows alongside the user-curated registry.
   */
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      max_new_probes: z.number().int().nonnegative().default(10),
      pacing_ms: z.number().int().nonnegative().default(1500),
      resolve_legal_names: z.boolean().default(true),
      /** Path B — scan listing description text for external URLs. */
      mine_description_urls: z.boolean().default(true),
      /** When true, Path B scopes to listings whose description carries new-build phrases. */
      new_build_only: z.boolean().default(false),
      /** Plan (b) — external seed URLs (news pages, list pages) to crawl for outgoing links. */
      external_seeds: z.array(z.string().url()).default([]),
      /** When true, newly discovered rows ship with `enabled: true` so they get scanned next cycle without manual approval. */
      auto_enable: z.boolean().default(false),
      /**
       * Geo allowlist applied to every agency-scrape pass. Adapter drops
       * listings whose `postal_code` / `city` / `region` doesn't match any
       * configured value. Listings with all three location fields null are
       * dropped conservatively. Filter is OR across the three lists.
       */
      region_filter: z
        .object({
          postal_codes: z
            .array(z.string().regex(/^\d{4}$/, 'PLZ must be a 4-digit Swiss postal code'))
            .default([]),
          cities: z.array(z.string().min(1)).default([]),
          cantons: z.array(z.string().length(2)).default([]),
        })
        .default({ postal_codes: [], cities: [], cantons: [] }),
    })
    .default({
      enabled: true,
      max_new_probes: 10,
      pacing_ms: 1500,
      resolve_legal_names: true,
      mine_description_urls: true,
      new_build_only: false,
      external_seeds: [],
      auto_enable: false,
      region_filter: { postal_codes: [], cities: [], cantons: [] },
    }),
});
export type TopConfig = z.infer<typeof TopConfig>;

export interface LoadedConfig {
  top: TopConfig;
  filters: z.infer<typeof FiltersFile>;
  scoring: z.infer<typeof ScoringFile>;
  rentalTerm: RentalTermPolicy;
  configDir: string;
  skippedAgencies: Array<{ id: string; platform: string; reason: string }>;
}

/** Default rental-term policy when `rental_term.yaml` is absent. Preserves pre-feature behavior modulo furnished/befristet auto-reject. */
const DEFAULT_RENTAL_TERM: RentalTermPolicy = { mode: 'long', exclude_unknown: false };

/** Reads and parses a YAML file. Cast assumes the caller validates the result through a schema. */
export function loadYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

/**
 * Loads the three top-level config files (`config.yaml`, `filters.yaml`,
 * `scoring.yaml`) from `configDir` and validates each through its Zod schema.
 * Additionally, if an `agencies` meta-source is enabled in `config.yaml`, loads
 * the referenced registry (file/HTTPS/git), optionally verifies its signature,
 * and expands enabled rows into synthetic source-plugin entries.
 *
 * @throws when any file is missing or fails schema validation.
 */
export async function loadConfig(
  configDir: string,
  opts: { dataDir?: string } = {},
): Promise<LoadedConfig> {
  const top = TopConfig.parse(loadYaml(join(configDir, 'config.yaml')));
  const filters = FiltersFile.parse(loadYaml(join(configDir, 'filters.yaml')));
  const scoring = ScoringFile.parse(loadYaml(join(configDir, 'scoring.yaml')));
  const rentalTermPath = join(configDir, 'rental_term.yaml');
  const rentalTerm = existsSync(rentalTermPath)
    ? RentalTermFile.parse(loadYaml(rentalTermPath)).rental_term
    : DEFAULT_RENTAL_TERM;
  const expanded = await expandAgenciesIfPresent(top, configDir, opts.dataDir);
  if (expanded) {
    top.enabled.sources = top.enabled.sources
      .filter((s) => s.plugin !== 'agencies')
      .concat(expanded.expandedSources);
  }
  return {
    top,
    filters,
    scoring,
    rentalTerm,
    configDir,
    skippedAgencies: expanded?.skipped ?? [],
  };
}

/**
 * Loads a plugin's YAML config relative to `configDir`, runs `${env.VAR}`
 * interpolation, then validates against the plugin-provided Zod schema.
 *
 * Supports an `inline:` prefix on `relPath` — the suffix is a base64-encoded
 * JSON blob (used by the agency-registry preprocessor so synthesised source
 * entries don't need on-disk YAML).
 */
export function loadPluginConfig<T extends z.ZodTypeAny>(
  configDir: string,
  relPath: string,
  schema: T,
): z.infer<T> {
  if (relPath.startsWith('inline:')) {
    const b64 = relPath.slice('inline:'.length);
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
    const interpolated = interpolateEnv(obj);
    return schema.parse(interpolated);
  }
  const full = join(configDir, relPath);
  const raw = loadYaml<unknown>(full);
  const interpolated = interpolateEnv(raw);
  return schema.parse(interpolated);
}

/** Helper: returns the directory portion of a config file path. */
export function configBaseDir(configFile: string): string {
  return dirname(configFile);
}

async function expandAgenciesIfPresent(
  top: TopConfig,
  configDir: string,
  dataDir?: string,
): Promise<{
  expandedSources: EnabledEntry[];
  skipped: Array<{ id: string; platform: string; reason: string }>;
} | null> {
  const meta = top.enabled.sources.find((s) => s.plugin === 'agencies');
  // We also want to honor the discovered registry even when the user hasn't
  // enabled the `agencies` meta-source — so the daemon's auto-discovery still
  // produces a useful next-cycle. A missing meta block means we only consider
  // the discovered registry.
  const discoveredFile = dataDir ? join(dataDir, 'agencies.discovered.yaml') : null;
  const hasDiscovered = discoveredFile ? existsSync(discoveredFile) : false;
  if (!meta && !hasDiscovered) return null;

  let registry: import('@wabe/core').AgencyRegistry | null = null;
  if (meta) {
    const metaCfgPath = join(configDir, meta.config);
    if (!existsSync(metaCfgPath)) throw new Error(`agencies meta config not found: ${metaCfgPath}`);
    const raw = loadYaml<{
      registry: string;
      registry_auth?: string;
      signature_pubkey?: string;
    }>(metaCfgPath);
    const ac = new AbortController();
    registry = await loadRegistry({
      registry: raw.registry,
      registry_auth: raw.registry_auth,
      configDir,
      signal: ac.signal,
    });
    if (raw.signature_pubkey) {
      // Local registry signature file convention: `<path>.sig` next to the YAML.
      // Only attempted for local-file registries; HTTPS/git signature transport is out of scope.
      const sigPath = `${raw.registry}.sig`;
      if (existsSync(sigPath) && existsSync(raw.registry)) {
        const sig = readFileSync(sigPath, 'utf8').trim();
        const payload = readFileSync(raw.registry, 'utf8');
        const ok = await verifySignature(payload, sig, raw.signature_pubkey);
        if (!ok) throw new Error('agency-registry signature verification failed');
      }
    }
  }

  // Discovered registry: merged in alongside the user-curated one. User-curated
  // entries take precedence on `id` collision so a manual classification can
  // override an auto-detected one.
  if (discoveredFile && hasDiscovered) {
    const raw = loadYaml<unknown>(discoveredFile);
    const parsed = (await import('@wabe/core')).AgencyRegistry.safeParse(raw);
    if (parsed.success) {
      const baseAgencies = registry?.agencies ?? [];
      const userIds = new Set(baseAgencies.map((a) => a.id));
      const additions = parsed.data.agencies.filter((a) => !userIds.has(a.id));
      registry = {
        version: 1 as const,
        source: registry?.source ?? 'discovered-only',
        agencies: [...baseAgencies, ...additions],
      };
    }
  }

  if (!registry) return null;
  const rf = top.discovery?.region_filter;
  const { expanded, skipped } = expandRegistry(registry, BUNDLED_ADAPTERS as Set<string>, {
    regionFilter: rf
      ? {
          postal_codes: rf.postal_codes,
          cities: rf.cities,
          cantons: rf.cantons,
        }
      : undefined,
  });
  return {
    expandedSources: expanded.map((e) => ({ name: e.name, plugin: e.plugin, config: e.config })),
    skipped,
  };
}
