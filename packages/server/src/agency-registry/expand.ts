import type { AgencyEntry, AgencyRegistry } from '@wabe/core';

export interface ExpandedSource {
  /** Synthetic name for the loaded plugin instance (also drives logging + breaker keys). */
  name: string;
  /** Bundled adapter package name (resolves through normal plugin loader). */
  plugin: string;
  /**
   * Inline config object (no file path — the loader supports both forms via
   * `EnabledEntry.config` being either a YAML path or, when prefixed with
   * `inline:`, a base64-encoded JSON blob; expandRegistry uses inline mode).
   */
  config: string;
}

export interface SkippedAgency {
  id: string;
  platform: AgencyEntry['platform'];
  reason: string;
}

export interface ExpandResult {
  expanded: ExpandedSource[];
  skipped: SkippedAgency[];
}

/** Map an agency `platform` value to the bundled adapter's npm name. */
function adapterFor(platform: AgencyEntry['platform']): string | null {
  switch (platform) {
    case 'schemaorg':
      return 'source-schemaorg';
    case 'immomig':
    case 'casasoft':
    case 'custom':
      return null;
  }
}

/**
 * Expands enabled agency rows into synthetic source-plugin entries that the
 * regular plugin loader can resolve. Rows referencing a platform whose adapter
 * isn't bundled in the current Wabe build go into `skipped` (never throws),
 * keeping registries forward-compatible with future bundled adapters.
 */
export function expandRegistry(reg: AgencyRegistry, bundledAdapterNames: Set<string>): ExpandResult {
  const expanded: ExpandedSource[] = [];
  const skipped: SkippedAgency[] = [];
  for (const a of reg.agencies) {
    if (!a.enabled) continue;
    const adapter = adapterFor(a.platform);
    if (adapter === null || !bundledAdapterNames.has(adapter)) {
      skipped.push({
        id: a.id,
        platform: a.platform,
        reason:
          adapter === null
            ? `platform "${a.platform}" has no bundled adapter`
            : `bundled adapter "${adapter}" not installed`,
      });
      continue;
    }
    // Inline config so the plugin loader doesn't need a YAML path per agency row.
    // Cross-task contract (T5↔T9): `agency_id` is consumed by source-schemaorg's
    // ConfigSchema to tag emitted listings and synthesize source names.
    const inlineConfig: Record<string, unknown> = {
      agency_id: a.id,
      website: a.website,
      canton: a.canton,
      priority: a.priority,
      rate_limit_per_min: a.rate_limit_per_min,
    };
    if (a.feed_url) inlineConfig.feed_url = a.feed_url;
    if (a.detail_url_template) inlineConfig.detail_url_template = a.detail_url_template;
    expanded.push({
      name: `agency:${a.platform}:${a.id}`,
      plugin: adapter,
      config: `inline:${Buffer.from(JSON.stringify(inlineConfig), 'utf8').toString('base64')}`,
    });
  }
  return { expanded, skipped };
}

/** List of platform→adapter mappings used by `BUNDLED_ADAPTERS`. Re-exported for the CLI. */
export const BUNDLED_ADAPTERS: ReadonlySet<string> = new Set(['source-schemaorg']);
