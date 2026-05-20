import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AgencyRegistry, type AgencyEntry } from '@wabe/core';

/**
 * Read the local "discovered" registry. The file is owned by Wabe (Bundle B
 * discovery writes to it) and lives alongside the user-curated registry. A
 * missing file is treated as an empty registry rather than an error so the
 * very first scan has nothing to merge against.
 */
export function readDiscoveredRegistry(path: string): {
  agencies: AgencyEntry[];
  knownIds: Set<string>;
} {
  if (!existsSync(path)) return { agencies: [], knownIds: new Set() };
  const raw = parseYaml(readFileSync(path, 'utf8'));
  const parsed = AgencyRegistry.safeParse(raw);
  if (!parsed.success) {
    // Don't throw — the file may be hand-edited and slightly off-spec. Treat
    // unparseable files as empty so discovery doesn't get stuck on a one-off
    // typo and the caller can warn out-of-band.
    return { agencies: [], knownIds: new Set() };
  }
  return { agencies: parsed.data.agencies, knownIds: new Set(parsed.data.agencies.map((a) => a.id)) };
}

/**
 * Write the discovered registry atomically. New entries are appended after
 * existing ones to keep diffs minimal across runs.
 */
export function writeDiscoveredRegistry(path: string, agencies: AgencyEntry[]): void {
  const doc = {
    version: 1 as const,
    source: 'discovered',
    fetched_at: new Date().toISOString(),
    agencies,
  };
  // Validate before writing so we never persist a malformed registry.
  AgencyRegistry.parse(doc);
  writeFileSync(path, stringifyYaml(doc), 'utf8');
}
