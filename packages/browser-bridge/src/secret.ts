import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_FILE = 'bridge-secret';
const HEX64 = /^[0-9a-f]{64}$/;

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Returns the persisted bridge secret, generating + writing one on first call.
 *
 * Stored at `${dataDir}/bridge-secret` with mode 0600 on unix. This is the
 * first file in Wabe to use the `${dataDir}/<secret-name>` pattern; later
 * secret stores can mirror it.
 */
export function loadOrGenerateSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, SECRET_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (HEX64.test(raw)) return raw;
  }
  const s = generateSecret();
  writeFileSync(path, s, { mode: 0o600 });
  return s;
}

/** Constant-time comparison; returns false on any malformed input. */
export function validateToken(expected: string, candidate: string): boolean {
  if (!HEX64.test(expected) || !HEX64.test(candidate)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
