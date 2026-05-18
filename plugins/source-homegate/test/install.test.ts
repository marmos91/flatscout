import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstall } from '../src/install.js';
import { USER_AGENT, X_APP_VERSION } from '../src/headers.js';

// Toggle to inject a non-ENOENT read failure into the next `readFileSync` call
// inside `getInstall`. Other call sites (e.g. test assertions) are unaffected
// because we only trip when the path ends with the install file name.
let readFailure: NodeJS.ErrnoException | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => {
      if (readFailure && typeof path === 'string' && path.endsWith('homegate-install.json')) {
        const err = readFailure;
        readFailure = null;
        throw err;
      }
      return actual.readFileSync(path, options);
    }) as typeof actual.readFileSync,
  };
});

describe('getInstall', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wabe-homegate-install-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a fresh UUID on first call and persists it with 0600 perms', () => {
    const first = getInstall(dir);
    expect(first.xUdid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(first.userAgent).toBe(USER_AGENT);
    expect(first.xAppVersion).toBe(X_APP_VERSION);

    const path = join(dir, 'homegate-install.json');
    const st = statSync(path);
    // Mode bits — verify owner-read/write only (0600). Mask to permission bits.
    expect(st.mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.xUdid).toBe(first.xUdid);
    expect(typeof parsed.createdAt).toBe('number');
  });

  it('returns the same UUID on subsequent calls', () => {
    const first = getInstall(dir);
    const second = getInstall(dir);
    expect(second.xUdid).toBe(first.xUdid);
  });

  it('propagates non-ENOENT read failures instead of clobbering the install file', () => {
    // Seed an install so the file genuinely exists.
    const first = getInstall(dir);
    const path = join(dir, 'homegate-install.json');
    const goodOnDisk = readFileSync(path, 'utf8');

    // Next read fails with EACCES (e.g. user lost permission). We must NOT
    // silently regenerate — the existing identity could still be valid and
    // an overwrite would lose the persistent xUdid.
    readFailure = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    }) as NodeJS.ErrnoException;

    expect(() => getInstall(dir)).toThrow(/permission denied/);

    // File on disk is untouched: same bytes, same xUdid.
    expect(readFileSync(path, 'utf8')).toBe(goodOnDisk);
    expect(JSON.parse(goodOnDisk).xUdid).toBe(first.xUdid);
  });
});
