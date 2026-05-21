import type { Command } from 'commander';
import { loadOrGenerateSecret } from '@flatscout/server';
import { resolvePaths } from '../../paths.js';
import { loadConfig } from '@flatscout/server';

const DEFAULT_PORT = 8431;
const BRIDGE_HOST = '127.0.0.1';

/**
 * `flatscout bridge pair` — prints the pairing URL + 64-char hex token. The user
 * pastes both into the Flatscout Bridge extension popup. The token is the same
 * shared secret consumed by the WS handshake; it's persisted at
 * `${dataDir}/bridge-secret` (mode 0600) by `loadOrGenerateSecret`.
 *
 * The bridge server always binds to 127.0.0.1 (loopback is hard-enforced
 * in `@flatscout/browser-bridge`); only the port is configurable.
 */
export function registerPair(parent: Command): void {
  parent
    .command('pair')
    .description('print pairing URL + token for the Flatscout Bridge extension')
    .action(async () => {
      const globalOpts = parent.parent?.opts<{ config?: string; dataDir?: string }>() ?? {};
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });

      // Prefer the configured port if the user customised it. Falls back to the default
      // (and to the default again on any config error — pairing should work even with no config yet).
      let port = DEFAULT_PORT;
      try {
        const cfg = await loadConfig(paths.configDir, { dataDir: paths.dataDir });
        port = cfg.top.bridge.port;
      } catch {
        // ignore — pre-init pairing is fine
      }

      const token = loadOrGenerateSecret(paths.dataDir);
      const url = `ws://${BRIDGE_HOST}:${port}/bridge`;

      console.log('Paste the following into the Flatscout Bridge extension popup:');
      console.log('');
      console.log(`  Bridge URL: ${url}`);
      console.log(`  Auth token: ${token}`);
      console.log('');
      console.log(`(Token stored at ${paths.dataDir}/bridge-secret, mode 0600.)`);
      console.log('Make sure `flatscout start` is running with `bridge.enabled: true`.');
    });
}
