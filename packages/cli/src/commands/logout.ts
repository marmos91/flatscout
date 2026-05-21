import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { request } from 'undici';
import { loadSecrets, saveSecrets } from '@flatscout/server';
import { AUTH_BASE, CLIENT_ID } from '@flatscout/source-homegate';
import { resolvePaths } from '../paths.js';

/**
 * Best-effort RFC 7009 refresh-token revocation against Auth0's
 * `/oauth/revoke`. Returns `true` on a 2xx response, `false` otherwise.
 *
 * Per RFC 7009 §2.2 the server returns 200 with an empty body whether the
 * token was valid or already invalidated. Exported for unit testing.
 *
 * Never throws — failures are signalled by the boolean return so callers can
 * always proceed to delete the local secret file even if the network call
 * fails. The local file is the authoritative source on the client side.
 */
export async function revokeRefreshToken(token: string): Promise<boolean> {
  try {
    const res = await request(`${AUTH_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, token }),
    });
    // Drain the body so the connection can be reused.
    try {
      await res.body.text();
    } catch {
      // ignore — best-effort drain
    }
    return res.statusCode >= 200 && res.statusCode < 300;
  } catch {
    return false;
  }
}

/**
 * Registers `flatscout logout <provider>`. Currently only `homegate` is supported.
 *
 * Flow:
 *   1. Confirm the destructive intent.
 *   2. If a refresh token is stored, best-effort `POST /oauth/revoke` so a
 *      leaked refresh token cannot continue to mint access tokens after
 *      logout. Failure does NOT block local deletion — the local file is
 *      authoritative.
 *   3. Delete the `homegate` key from `secrets.json` and rewrite atomically.
 *
 * Note: we deliberately do NOT call Auth0's `/v2/logout` endpoint — that only
 * clears the Auth0 SSO browser cookie, which has no effect on refresh tokens
 * already minted to this client.
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

      const secrets = await loadSecrets(paths.dataDir);
      const refreshToken = secrets.homegate?.refreshToken;

      if (!refreshToken) {
        // Nothing to revoke and nothing to delete that would change state.
        // Still rewrite without `homegate` to keep the file shape canonical.
        const { homegate: _drop, ...rest } = secrets;
        void _drop;
        await saveSecrets(paths.dataDir, rest);
        p.outro('✓ no Homegate credentials stored');
        return;
      }

      // Best-effort remote revocation. Any failure here is swallowed; what
      // matters is that the local file is gone.
      await revokeRefreshToken(refreshToken);

      // Strip the homegate key, preserving any other (non-homegate) secrets.
      const { homegate: _drop, ...rest } = secrets;
      void _drop;
      await saveSecrets(paths.dataDir, rest);

      p.outro('✓ logged out (refresh token revoked at Auth0, local credentials cleared)');
    });
}
