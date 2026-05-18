import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { interpolateEnv, FiltersFile, ScoringFile } from '@wabe/core';
import { parse as parseYaml } from 'yaml';

export const EnabledEntry = z.object({
  name: z.string(),
  plugin: z.string(),
  config: z.string(),
});
export type EnabledEntry = z.infer<typeof EnabledEntry>;

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

export function loadYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, 'utf8')) as T;
}

export function loadConfig(configDir: string): LoadedConfig {
  const top = TopConfig.parse(loadYaml(join(configDir, 'config.yaml')));
  const filters = FiltersFile.parse(loadYaml(join(configDir, 'filters.yaml')));
  const scoring = ScoringFile.parse(loadYaml(join(configDir, 'scoring.yaml')));
  return { top, filters, scoring, configDir };
}

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

export function configBaseDir(configFile: string): string {
  return dirname(configFile);
}
