import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { interpolateEnv, FiltersFile, ScoringFile } from '@wabe/core';
import { parse as parseYaml } from 'yaml';

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
});
export type TopConfig = z.infer<typeof TopConfig>;

export interface LoadedConfig {
  top: TopConfig;
  filters: z.infer<typeof FiltersFile>;
  scoring: z.infer<typeof ScoringFile>;
  configDir: string;
}

/** Reads and parses a YAML file. Cast assumes the caller validates the result through a schema. */
export function loadYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

/**
 * Loads the three top-level config files (`config.yaml`, `filters.yaml`,
 * `scoring.yaml`) from `configDir` and validates each through its Zod schema.
 *
 * @throws when any file is missing or fails schema validation.
 */
export function loadConfig(configDir: string): LoadedConfig {
  const top = TopConfig.parse(loadYaml(join(configDir, 'config.yaml')));
  const filters = FiltersFile.parse(loadYaml(join(configDir, 'filters.yaml')));
  const scoring = ScoringFile.parse(loadYaml(join(configDir, 'scoring.yaml')));
  return { top, filters, scoring, configDir };
}

/**
 * Loads a plugin's YAML config relative to `configDir`, runs `${env.VAR}`
 * interpolation, then validates against the plugin-provided Zod schema.
 */
export function loadPluginConfig<T extends z.ZodTypeAny>(
  configDir: string,
  relPath: string,
  schema: T,
): z.infer<T> {
  const full = join(configDir, relPath);
  const raw = loadYaml<unknown>(full);
  const interpolated = interpolateEnv(raw);
  return schema.parse(interpolated);
}

/** Helper: returns the directory portion of a config file path. */
export function configBaseDir(configFile: string): string {
  return dirname(configFile);
}
