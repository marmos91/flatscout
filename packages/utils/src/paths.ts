import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the Flatscout data directory: `$FLATSCOUT_DATA_DIR` → `$XDG_DATA_HOME/flatscout` →
 * `~/.local/share/flatscout`. Plugins read/write secrets and bridge status here.
 */
export function resolveDataDir(): string {
  if (process.env.FLATSCOUT_DATA_DIR) return process.env.FLATSCOUT_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'flatscout');
}
