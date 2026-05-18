import crypto from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_AGENT, X_APP_VERSION } from './headers.js';

export interface InstallIdentity {
  xUdid: string;
  userAgent: string;
  xAppVersion: string;
}

interface InstallFile {
  xUdid: string;
  createdAt: number;
}

const FILE_NAME = 'homegate-install.json';

/**
 * Returns the stable per-install identity (xUdid + pinned UA/version).
 *
 * On first call, generates a fresh UUIDv4, writes it to
 * `${dataDir}/homegate-install.json` (atomic tmp + rename, mode 0600), and
 * returns it. Subsequent calls re-read the same file so the identity is
 * preserved across runs — matching the iOS app's per-device-persistent UDID.
 */
export function getInstall(dataDir: string): InstallIdentity {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, FILE_NAME);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as InstallFile;
    if (typeof parsed.xUdid === 'string' && parsed.xUdid.length > 0) {
      return { xUdid: parsed.xUdid, userAgent: USER_AGENT, xAppVersion: X_APP_VERSION };
    }
  } catch (err) {
    // ENOENT or malformed JSON → regenerate below.
    if ((err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Malformed file: fall through and overwrite.
    }
  }
  const xUdid = crypto.randomUUID().toUpperCase();
  const data: InstallFile = { xUdid, createdAt: Date.now() };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return { xUdid, userAgent: USER_AGENT, xAppVersion: X_APP_VERSION };
}
