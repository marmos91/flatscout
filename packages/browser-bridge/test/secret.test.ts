import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecret, loadOrGenerateSecret, validateToken } from '../src/secret.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-bridge-secret-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generateSecret', () => {
  it('returns a 64-char hex string (32 bytes)', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns a different value each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('loadOrGenerateSecret', () => {
  it('generates + persists on first call', () => {
    const s = loadOrGenerateSecret(dir);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    const persisted = readFileSync(join(dir, 'bridge-secret'), 'utf8').trim();
    expect(persisted).toBe(s);
  });
  it.runIf(platform() !== 'win32')('persists with mode 0600 on unix', () => {
    loadOrGenerateSecret(dir);
    const mode = statSync(join(dir, 'bridge-secret')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it('reuses the persisted secret on subsequent calls', () => {
    const a = loadOrGenerateSecret(dir);
    const b = loadOrGenerateSecret(dir);
    expect(a).toBe(b);
  });
  it('regenerates if the persisted value is corrupted', () => {
    loadOrGenerateSecret(dir);
    writeFileSync(join(dir, 'bridge-secret'), 'not-hex-at-all');
    const s = loadOrGenerateSecret(dir);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(s).not.toBe('not-hex-at-all');
  });
  it('creates the data directory if it does not exist', () => {
    const nested = join(dir, 'does/not/exist/yet');
    const s = loadOrGenerateSecret(nested);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validateToken', () => {
  it('accepts the right token', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, s)).toBe(true);
  });
  it('rejects a wrong token of the same length', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, 'b'.repeat(64))).toBe(false);
  });
  it('rejects a malformed (non-hex) token', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, 'nothex')).toBe(false);
  });
  it('rejects a short token', () => {
    const s = loadOrGenerateSecret(dir);
    expect(validateToken(s, 'a'.repeat(32))).toBe(false);
  });
  it('rejects when expected is malformed', () => {
    expect(validateToken('not-hex', 'a'.repeat(64))).toBe(false);
  });
});
