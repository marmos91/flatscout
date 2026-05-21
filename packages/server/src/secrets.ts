import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shape of the `secrets.json` file under the data dir.
 *
 * IMPORTANT: this shape MUST stay in sync with the parallel reader/writer in
 * `plugins/source-homegate/src/auth.ts`. Plugins cannot depend on
 * `@flatscout/server` (the server is what loads them), so the same file is touched
 * from two places. Keep keys and types identical between the two modules.
 */
export interface HomegateSecrets {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms when the access token expires (Date.now() + expires_in * 1000). */
  accessTokenExpiresAt: number;
  idToken?: string;
  userSub?: string;
  /** Epoch ms timestamp of the last successful interactive login. */
  loggedInAt: number;
}

export interface SecretsFile {
  homegate?: HomegateSecrets;
}

const SECRETS_FILE = 'secrets.json';

/**
 * Reads `${dataDir}/secrets.json`. Returns `{}` if the file is missing or
 * unreadable — secrets are always optional from the caller's perspective.
 */
export async function loadSecrets(dataDir: string): Promise<SecretsFile> {
  const path = join(dataDir, SECRETS_FILE);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SecretsFile;
  } catch {
    return {};
  }
}

/**
 * Atomically writes `secrets` to `${dataDir}/secrets.json` with mode `0600`.
 *
 * Uses the same tmp + rename pattern as `cookies.ts` / `install.ts` so a
 * concurrent reader never observes a half-written file. `chmod` is applied
 * post-rename because `writeFile`'s `mode` option does not survive `rename`
 * across all platforms.
 */
export async function saveSecrets(dataDir: string, secrets: SecretsFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, SECRETS_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** Convenience: returns the Homegate refresh token, or `null` when not logged in. */
export async function getHomegateRefreshToken(dataDir: string): Promise<string | null> {
  const secrets = await loadSecrets(dataDir);
  return secrets.homegate?.refreshToken ?? null;
}

/**
 * Convenience: persists a new Homegate token bundle, preserving any other
 * (non-homegate) keys already present in `secrets.json`.
 */
export async function setHomegateTokens(dataDir: string, tokens: HomegateSecrets): Promise<void> {
  const secrets = await loadSecrets(dataDir);
  secrets.homegate = tokens;
  await saveSecrets(dataDir, secrets);
}
