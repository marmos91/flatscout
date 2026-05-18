import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { request } from 'undici';
import { loadSecrets, saveSecrets } from '@wabe/server';
import { resolvePaths } from '../paths.js';
import { AUTH_BASE, CLIENT_ID } from './login.js';

/**
 * Registers `wabe logout <provider>`. Currently only `homegate` is supported.
 *
 * Flow:
 *   1. Confirm the destructive intent.
 *   2. Best-effort call Auth0's `/v2/logout` to revoke the session (failure
 *      does NOT block the local deletion — the local secret file is the
 *      source of truth).
 *   3. Delete the `homegate` key from `secrets.json` and rewrite atomically.
 */
export function registerLogout(prog: Command): void {
  prog
    .command('logout <provider>')
    .description('Revoke stored credentials (provider: homegate)')
    .action(async (provider: string) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });

      if (provider !== 'homegate') {
        console.error(`unknown provider "${provider}" — supported: homegate`);
        process.exit(1);
      }

      p.intro('logout → homegate');

      const confirm = await p.confirm({
        message: 'Revoke Homegate refresh token and delete local credentials?',
        initialValue: false,
      });
      if (p.isCancel(confirm) || confirm !== true) {
        p.cancel('logout aborted');
        process.exit(1);
      }

      // Best-effort remote revocation. Any failure here is logged and
      // ignored; what matters is that the local file is gone.
      try {
        await request(`${AUTH_BASE}/v2/logout?client_id=${encodeURIComponent(CLIENT_ID)}`, {
          method: 'GET',
        });
      } catch {
        // ignored — see comment above
      }

      const secrets = await loadSecrets(paths.dataDir);
      // Strip the homegate key, preserving any other (non-homegate) secrets.
      const { homegate: _drop, ...rest } = secrets;
      void _drop;
      await saveSecrets(paths.dataDir, rest);

      p.outro('✓ logged out');
    });
}
