import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootstrapResult } from '@wabe/browser-runtime';

const FILE_NAME = 'homegate-cookies.json';
const DEFAULT_MAX_AGE_MS = 12 * 3600_000;

/**
 * Reads `${dataDir}/homegate-cookies.json` if present and returns the parsed
 * `BootstrapResult`. Returns `null` when the file is missing or malformed.
 */
export async function loadCookies(dataDir: string): Promise<BootstrapResult | null> {
  const path = join(dataDir, FILE_NAME);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BootstrapResult;
  } catch {
    return null;
  }
}

/**
 * Atomically persists `result` to `${dataDir}/homegate-cookies.json` with
 * mode 0600 (tmp + rename so concurrent readers never see a half-written file).
 */
export async function saveCookies(dataDir: string, result: BootstrapResult): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, FILE_NAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/** Removes the persisted cookie file. No-op if the file does not exist. */
export async function deleteCookies(dataDir: string): Promise<void> {
  const path = join(dataDir, FILE_NAME);
  try {
    await unlink(path);
  } catch {
    // ignore ENOENT
  }
}

/**
 * True when `result` was captured less than `maxAgeMs` ago.
 *
 * Default max age is 12 hours, matching DataDome's typical session window
 * before re-challenge.
 */
export function isCookieFresh(result: BootstrapResult, maxAgeMs: number = DEFAULT_MAX_AGE_MS): boolean {
  return result.capturedAt + maxAgeMs > Date.now();
}
