import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '@flatscout/utils';

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
 * `FLATSCOUT_CONFIG_DIR` / `FLATSCOUT_DATA_DIR` → `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` →
 * platform defaults under `~/.config` and `~/.local/share`. Both directories
 * are created if missing.
 */
export function resolvePaths(opts: { config?: string; dataDir?: string } = {}): ResolvedPaths {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const configDir = opts.config ?? process.env.FLATSCOUT_CONFIG_DIR ?? join(xdgConfig, 'flatscout');
  const dataDir = opts.dataDir ?? resolveDataDir();
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { configDir, dataDir, dbFile: join(dataDir, 'flatscout.db') };
}

/**
 * Locates a built-in example config tree (e.g. `examples/zurich-family/config/`)
 * by walking up from this module's URL until a `pnpm-workspace.yaml` sibling
 * with an `examples/<name>/config/` subtree is found. Returns the absolute path
 * to that config dir. Throws if no matching tree exists.
 *
 * @todo when published as a standalone npm package, bundle examples/ via
 *   package.json `files` and resolve relative to the package root instead of
 *   walking the monorepo.
 */
export function resolveExampleDir(name: string): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  // Walk up until filesystem root.
  while (true) {
    const workspaceFile = join(dir, 'pnpm-workspace.yaml');
    const candidate = join(dir, 'examples', name, 'config');
    if (existsSync(workspaceFile) && existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate example "${name}" by walking up from ${here}. Expected to find a pnpm-workspace.yaml ancestor with examples/${name}/config/. If you are running outside the monorepo, pass --example-dir <absolute-path> to override.`,
  );
}
