import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { request } from 'undici';
import { AUTH_BASE, CLIENT_ID } from './constants.js';
import { HomegateAuthError } from './errors.js';

const TOKEN_PATH = '/oauth/token';
const SECRETS_FILE = 'secrets.json';
const REFRESH_SKEW_MS = 60_000;

interface HomegateSecrets {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  idToken?: string;
  userSub?: string;
  loggedInAt: number;
}

interface SecretsFile {
  homegate?: HomegateSecrets;
}

async function readSecrets(dataDir: string): Promise<SecretsFile> {
  const path = join(dataDir, SECRETS_FILE);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SecretsFile;
  } catch {
    return {};
  }
}

async function writeSecrets(dataDir: string, secrets: SecretsFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, SECRETS_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  // Re-apply chmod after rename — `writeFile`'s `mode` option does not survive
  // `rename` across all platforms (mirrors `@wabe/server`'s `secrets.ts`).
  await chmod(path, 0o600);
}

/**
 * Returns a valid Homegate access token, refreshing it via the Auth0
 * refresh-token grant when the cached token is within `REFRESH_SKEW_MS` of
 * expiry. Persists the rotated refresh + access tokens back to
 * `${dataDir}/secrets.json`.
 *
 * Returns `null` when no `homegate` secrets exist (user is not logged in).
 * Throws `HomegateAuthError` on a non-2xx refresh response.
 *
 * Phase 2 ships this module wired but unused — search is anonymous. Phase 3
 * connects it to `FetchContext.getBearer`.
 */
export async function getAccessToken(dataDir: string, logger: Logger): Promise<string | null> {
  const secrets = await readSecrets(dataDir);
  const hg = secrets.homegate;
  if (!hg) return null;

  if (hg.accessTokenExpiresAt > Date.now() + REFRESH_SKEW_MS) {
    return hg.accessToken;
  }

  logger.debug('homegate access token expired; refreshing');
  const url = `${AUTH_BASE}${TOKEN_PATH}`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: hg.refreshToken,
    }),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new HomegateAuthError(res.statusCode, url, text);
  }

  const payload = (await res.body.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
    token_type?: string;
  };

  const next: HomegateSecrets = {
    refreshToken: payload.refresh_token ?? hg.refreshToken,
    accessToken: payload.access_token,
    accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
    idToken: payload.id_token ?? hg.idToken,
    userSub: hg.userSub,
    loggedInAt: hg.loggedInAt,
  };
  await writeSecrets(dataDir, { ...secrets, homegate: next });
  logger.info('homegate access token refreshed');
  return next.accessToken;
}
