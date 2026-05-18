import type { PluginExport, PluginKind } from '@wabe/plugin-sdk';
import type { LoadedConfig } from './config.js';
import { loadPluginConfig } from './config.js';

export interface LoadedPlugin<K extends PluginKind = PluginKind> {
  name: string;
  kind: K;
  plugin: Extract<PluginExport, { kind: K }>['plugin'];
  config: unknown;
}

/**
 * Resolves and validates every plugin declared in `cfg.top.enabled.*`.
 *
 * For each declared entry: dynamically `import()`s the plugin's package,
 * checks its default export is a `PluginExport` of the expected kind
 * (mismatch throws), and validates its per-plugin YAML config through the
 * plugin-provided Zod schema. Returns the plugins bucketed by kind so the
 * pipeline can dispatch each stage without re-discriminating.
 *
 * @throws if any plugin package fails to import, lacks a default export,
 *         declares the wrong `kind`, or has an invalid config.
 */
export async function loadPlugins(cfg: LoadedConfig): Promise<{
  sources: LoadedPlugin<'source'>[];
  notifiers: LoadedPlugin<'notifier'>[];
  enrichers: LoadedPlugin<'enricher'>[];
  scorers: LoadedPlugin<'scorer'>[];
  applicators: LoadedPlugin<'applicator'>[];
}> {
  const buckets = {
    sources: [] as LoadedPlugin<'source'>[],
    notifiers: [] as LoadedPlugin<'notifier'>[],
    enrichers: [] as LoadedPlugin<'enricher'>[],
    scorers: [] as LoadedPlugin<'scorer'>[],
    applicators: [] as LoadedPlugin<'applicator'>[],
  };
  for (const e of cfg.top.enabled.sources) buckets.sources.push(await load('source', e, cfg));
  for (const e of cfg.top.enabled.notifiers) buckets.notifiers.push(await load('notifier', e, cfg));
  for (const e of cfg.top.enabled.enrichers) buckets.enrichers.push(await load('enricher', e, cfg));
  for (const e of cfg.top.enabled.scorers) buckets.scorers.push(await load('scorer', e, cfg));
  for (const e of cfg.top.enabled.applicators) buckets.applicators.push(await load('applicator', e, cfg));
  return buckets;
}

async function load<K extends PluginKind>(
  expectedKind: K,
  entry: { name: string; plugin: string; config: string },
  cfg: LoadedConfig,
): Promise<LoadedPlugin<K>> {
  const packageName = entry.plugin.startsWith('@') ? entry.plugin : `@wabe/${entry.plugin}`;
  const mod = (await import(packageName)) as { default?: PluginExport };
  if (!mod.default) throw new Error(`plugin ${packageName} missing default export`);
  if (mod.default.kind !== expectedKind) {
    throw new Error(
      `plugin ${packageName} kind=${mod.default.kind} but config expected ${expectedKind} for '${entry.name}'`,
    );
  }
  const exp = mod.default as Extract<PluginExport, { kind: K }>;
  const parsedConfig = loadPluginConfig(cfg.configDir, entry.config, exp.plugin.configSchema);
  return {
    name: entry.name,
    kind: expectedKind,
    plugin: exp.plugin,
    config: parsedConfig,
  } as LoadedPlugin<K>;
}
