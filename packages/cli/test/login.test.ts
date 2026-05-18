import { describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import {
  AUDIENCE,
  AUTH_BASE,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  buildAuthorizeUrl,
  decodeIdTokenPayload,
  exchangeCodeForTokens,
  generatePkce,
  parseRedirectUrl,
} from '../src/commands/login.js';

describe('generatePkce', () => {
  it('returns base64url-shaped verifier and challenge and a 32-hex state', () => {
    const { verifier, challenge, state } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toBe(challenge);
    // 32 bytes base64url ≈ 43 chars
    expect(verifier.length).toBeGreaterThanOrEqual(42);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces a fresh pair every call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('buildAuthorizeUrl', () => {
  it('contains every required OAuth2 + PKCE param', () => {
    const pkce = generatePkce();
    const url = buildAuthorizeUrl(pkce);
    expect(url.startsWith(`${AUTH_BASE}/authorize?`)).toBe(true);
    const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(qs.get('response_type')).toBe('code');
    expect(qs.get('client_id')).toBe(CLIENT_ID);
    expect(qs.get('scope')).toBe(SCOPE);
    expect(qs.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(qs.get('audience')).toBe(AUDIENCE);
    expect(qs.get('code_challenge_method')).toBe('S256');
    expect(qs.get('code_challenge')).toBe(pkce.challenge);
    expect(qs.get('state')).toBe(pkce.state);
  });

  it('round-trips the state from generatePkce', () => {
    const pkce = generatePkce();
    const url = buildAuthorizeUrl(pkce);
    const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(qs.get('state')).toBe(pkce.state);
  });
});

describe('parseRedirectUrl', () => {
  it('happy path extracts code', () => {
    const { code } = parseRedirectUrl('homegate://login/redirect?code=abc123&state=deadbeef', 'deadbeef');
    expect(code).toBe('abc123');
  });

  it('rejects wrong scheme', () => {
    expect(() => parseRedirectUrl('https://example.com/?code=a&state=b', 'b')).toThrow(
      /homegate:\/\/login\/redirect/,
    );
  });

  it('rejects missing code', () => {
    expect(() => parseRedirectUrl('homegate://login/redirect?state=b', 'b')).toThrow(/code/);
  });

  it('rejects missing state', () => {
    expect(() => parseRedirectUrl('homegate://login/redirect?code=a', 'b')).toThrow(/state/);
  });

  it('rejects state mismatch as CSRF protection', () => {
    expect(() => parseRedirectUrl('homegate://login/redirect?code=a&state=wrong', 'expected')).toThrow(
      /state mismatch/,
    );
  });

  it('surfaces an error= response param', () => {
    expect(() =>
      parseRedirectUrl(
        'homegate://login/redirect?error=access_denied&error_description=user+aborted&state=s',
        's',
      ),
    ).toThrow(/access_denied/);
  });
});

describe('decodeIdTokenPayload', () => {
  it('decodes the middle segment to JSON', () => {
    const header = Buffer.from('{"alg":"RS256"}').toString('base64url');
    const payload = Buffer.from('{"sub":"auth0|abc","email":"a@b.ch"}').toString('base64url');
    const sig = 'XXXX';
    const jwt = `${header}.${payload}.${sig}`;
    const out = decodeIdTokenPayload(jwt);
    expect(out).toEqual({ sub: 'auth0|abc', email: 'a@b.ch' });
  });

  it('returns null on malformed JWT', () => {
    expect(decodeIdTokenPayload('not-a-jwt')).toBeNull();
    expect(decodeIdTokenPayload('a.b')).toBeNull();
    expect(decodeIdTokenPayload('a.@@@@.c')).toBeNull();
  });
});

describe('exchangeCodeForTokens', () => {
  let prev: Dispatcher;

  function setup() {
    prev = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    return agent;
  }

  function teardown() {
    setGlobalDispatcher(prev);
  }

  it('returns a token bundle on 200', async () => {
    const agent = setup();
    try {
      const pool = agent.get(AUTH_BASE);
      pool.intercept({ method: 'POST', path: '/oauth/token' }).reply(200, {
        access_token: 'AT',
        refresh_token: 'RT',
        id_token: 'IT',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: SCOPE,
      });
      const out = await exchangeCodeForTokens('code-xyz', 'verifier-xyz');
      expect(out.access_token).toBe('AT');
      expect(out.refresh_token).toBe('RT');
      expect(out.expires_in).toBe(1800);
      await agent.close();
    } finally {
      teardown();
    }
  });

  it('throws on non-2xx', async () => {
    const agent = setup();
    try {
      const pool = agent.get(AUTH_BASE);
      pool.intercept({ method: 'POST', path: '/oauth/token' }).reply(400, { error: 'invalid_grant' });
      await expect(exchangeCodeForTokens('bad', 'v')).rejects.toThrow(/HTTP 400/);
      await agent.close();
    } finally {
      teardown();
    }
  });

  it('throws when response is missing required fields', async () => {
    const agent = setup();
    try {
      const pool = agent.get(AUTH_BASE);
      pool.intercept({ method: 'POST', path: '/oauth/token' }).reply(200, { access_token: 'AT' });
      await expect(exchangeCodeForTokens('c', 'v')).rejects.toThrow(/missing required fields/);
      await agent.close();
    } finally {
      teardown();
    }
  });
});
