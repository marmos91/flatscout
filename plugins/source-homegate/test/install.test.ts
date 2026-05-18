import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInstall } from '../src/install.js';
import { USER_AGENT, X_APP_VERSION } from '../src/headers.js';

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
});
