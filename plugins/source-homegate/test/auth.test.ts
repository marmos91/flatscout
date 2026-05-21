import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import pino from 'pino';
import { getAccessToken } from '../src/auth.js';
import { HomegateAuthError } from '../src/errors.js';

const logger = pino({ level: 'silent' });

let originalDispatcher: Dispatcher;
let agent: MockAgent;
let dir: string;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  dir = mkdtempSync(join(tmpdir(), 'flatscout-homegate-auth-'));
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
  rmSync(dir, { recursive: true, force: true });
});

function writeSecrets(homegate: Record<string, unknown>): void {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ homegate }, null, 2), { mode: 0o600 });
}

describe('getAccessToken', () => {
  it('returns null when no secrets file is present', async () => {
    expect(await getAccessToken(dir, logger)).toBeNull();
  });

  it('returns the cached access token when not yet near expiry', async () => {
    writeSecrets({
      refreshToken: 'rf-old',
      accessToken: 'at-cached',
      accessTokenExpiresAt: Date.now() + 30 * 60_000,
      loggedInAt: Date.now(),
    });
    expect(await getAccessToken(dir, logger)).toBe('at-cached');
  });

  it('refreshes near expiry, rotates the refresh token, persists secrets', async () => {
    writeSecrets({
      refreshToken: 'rf-old',
      accessToken: 'at-expired',
      accessTokenExpiresAt: Date.now() - 10_000,
      loggedInAt: 1700000000000,
    });

    const pool = agent.get('https://auth.homegate.ch');
    pool.intercept({ method: 'POST', path: '/oauth/token' }).reply(200, {
      access_token: 'at-new',
      refresh_token: 'rf-new',
      id_token: 'id-new',
      expires_in: 1800,
      token_type: 'Bearer',
      scope: 'openid profile email offline_access',
    });

    const token = await getAccessToken(dir, logger);
    expect(token).toBe('at-new');

    const stored = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
    expect(stored.homegate.accessToken).toBe('at-new');
    expect(stored.homegate.refreshToken).toBe('rf-new');
    expect(stored.homegate.idToken).toBe('id-new');
    expect(stored.homegate.accessTokenExpiresAt).toBeGreaterThan(Date.now() + 1_700_000);
  });

  it('throws HomegateAuthError on a 401 refresh and does not touch secrets', async () => {
    writeSecrets({
      refreshToken: 'rf-stale',
      accessToken: 'at-stale',
      accessTokenExpiresAt: Date.now() - 10_000,
      loggedInAt: 1700000000000,
    });
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8');

    const pool = agent.get('https://auth.homegate.ch');
    pool
      .intercept({ method: 'POST', path: '/oauth/token' })
      .reply(401, JSON.stringify({ error: 'invalid_grant' }));

    await expect(getAccessToken(dir, logger)).rejects.toBeInstanceOf(HomegateAuthError);
    const after = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(after).toBe(before);
  });
});
