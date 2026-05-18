import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapResult } from '@wabe/browser-runtime';
import { isCookieFresh, loadCookies, saveCookies } from '../src/cookies.js';

// Failure mode for the atomicity test. When set, the mocked `rename` rejects
// once with this error and then defers to the real implementation.
let renameFailure: NodeJS.ErrnoException | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameFailure) {
        const err = renameFailure;
        renameFailure = null;
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

function makeResult(capturedAt: number): BootstrapResult {
  return {
    cookieHeader: 'datadome=abc; __cf_bm=def',
    cookies: [
      { name: 'datadome', value: 'abc', domain: '.homegate.ch', expires: null },
      { name: '__cf_bm', value: 'def', domain: '.homegate.ch', expires: null },
    ],
    capturedAt,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome',
  };
}

describe('saveCookies + loadCookies', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wabe-homegate-cookies-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file is missing', async () => {
    expect(await loadCookies(dir)).toBeNull();
  });

  it('roundtrips a BootstrapResult atomically', async () => {
    const original = makeResult(1_700_000_000_000);
    await saveCookies(dir, original);
    const loaded = await loadCookies(dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.cookieHeader).toBe(original.cookieHeader);
    expect(loaded?.cookies).toHaveLength(2);
    expect(loaded?.capturedAt).toBe(original.capturedAt);
  });

  it('leaves the existing file untouched when the rename step fails', async () => {
    const first = makeResult(1_700_000_000_000);
    await saveCookies(dir, first);

    // The on-disk file at this point is the canonical "known good" copy.
    const path = join(dir, 'homegate-cookies.json');
    const goodOnDisk = readFileSync(path, 'utf8');

    // Simulate a rename failure during the *next* save. tmp file may be
    // written, but the rename must not be observed atomically and the
    // original file must remain intact.
    renameFailure = Object.assign(new Error('EPERM: simulated rename failure'), {
      code: 'EPERM',
    }) as NodeJS.ErrnoException;

    const second = makeResult(1_800_000_000_000);
    await expect(saveCookies(dir, second)).rejects.toThrow(/simulated rename failure/);

    // Original cookies still on disk, byte-for-byte.
    expect(readFileSync(path, 'utf8')).toBe(goodOnDisk);
    const reloaded = await loadCookies(dir);
    expect(reloaded?.capturedAt).toBe(first.capturedAt);
  });
});

describe('isCookieFresh', () => {
  const maxAge = 12 * 3600_000;
  const now = Date.now();

  it('returns true within the window', () => {
    expect(isCookieFresh(makeResult(now - maxAge + 1000), maxAge)).toBe(true);
  });

  it('returns false past the window', () => {
    expect(isCookieFresh(makeResult(now - maxAge - 1000), maxAge)).toBe(false);
  });

  it('default window is 12 hours', () => {
    expect(isCookieFresh(makeResult(now - 11 * 3600_000))).toBe(true);
    expect(isCookieFresh(makeResult(now - 13 * 3600_000))).toBe(false);
  });
});
