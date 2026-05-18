import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedPaths {
  configDir: string;
  dataDir: string;
  dbFile: string;
}

/**
 * Resolves the config and data directories per XDG Base Directory spec, with
 * explicit overrides taking highest precedence.
 *
 * Precedence (highest first): explicit `opts.config`/`opts.dataDir` → env vars
 * `WABE_CONFIG_DIR` / `WABE_DATA_DIR` → `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` →
 * platform defaults under `~/.config` and `~/.local/share`. Both directories
 * are created if missing.
 */
export function resolvePaths(opts: { config?: string; dataDir?: string } = {}): ResolvedPaths {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const configDir = opts.config ?? process.env.WABE_CONFIG_DIR ?? join(xdgConfig, 'wabe');
  const dataDir = opts.dataDir ?? process.env.WABE_DATA_DIR ?? join(xdgData, 'wabe');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { configDir, dataDir, dbFile: join(dataDir, 'wabe.db') };
}
