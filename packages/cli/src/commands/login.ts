import crypto from 'node:crypto';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { request } from 'undici';
import { setHomegateTokens } from '@wabe/server';
import { AUDIENCE, AUTH_BASE, CLIENT_ID, REDIRECT_URI, SCOPE } from '@wabe/source-homegate';
import { resolvePaths } from '../paths.js';

// Re-exported so existing tests can keep importing them from the login module
// without churn — the canonical source is `@wabe/source-homegate`.
export { AUDIENCE, AUTH_BASE, CLIENT_ID, REDIRECT_URI, SCOPE };

/**
 * Pure PKCE primitives — base64url-encoded `verifier` + SHA-256 `challenge`
 * + 32-hex-char `state`. Exported so the unit test exercises the same code
 * path the interactive flow takes.
 */
export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Generates a fresh PKCE pair: 32-byte verifier → 43-char base64url string,
 * SHA-256 challenge over the verifier, and a 32-hex-char `state` nonce.
 */
export function generatePkce(): PkcePair {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  return { verifier, challenge, state };
}

/**
 * Builds the Auth0 `/authorize` URL the user pastes into a browser. All
 * query params are explicitly encoded — never rely on URL implicit encoding
 * for the `audience` / `scope` values.
 */
export function buildAuthorizeUrl(pkce: PkcePair): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    audience: AUDIENCE,
    code_challenge_method: 'S256',
    code_challenge: pkce.challenge,
    state: pkce.state,
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Validates a pasted redirect URL and extracts the `code` query param.
 *
 * Rejects URLs that don't start with `homegate://login/redirect?`, lack the
 * `code` param, or have a `state` mismatch. State mismatch is treated as a
 * hard failure (CSRF protection).
 */
export function parseRedirectUrl(url: string, expectedState: string): { code: string } {
  const trimmed = url.trim();
  if (!trimmed.startsWith('homegate://login/redirect?')) {
    throw new Error(
      'redirect URL must start with "homegate://login/redirect?" — check the browser address bar after authorising',
    );
  }
  const qIdx = trimmed.indexOf('?');
  const qs = new URLSearchParams(trimmed.slice(qIdx + 1));
  const code = qs.get('code');
  const state = qs.get('state');
  const err = qs.get('error');
  if (err) {
    throw new Error(
      `authorisation server returned error: ${err}${qs.get('error_description') ? ` — ${qs.get('error_description')}` : ''}`,
    );
  }
  if (!code) throw new Error('redirect URL is missing the "code" query parameter');
  if (!state) throw new Error('redirect URL is missing the "state" query parameter');
  if (state !== expectedState) {
    throw new Error('state mismatch — refusing to exchange code (possible CSRF or stale browser tab)');
  }
  return { code };
}

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

/**
 * Exchanges an authorisation code for a token bundle via Auth0's
 * `/oauth/token`. Body shape follows the iOS capture (JSON, not form-encoded
 * — Auth0 tolerates both but we match what the live app does).
 *
 * Throws on any non-2xx response; never logs the `code` or any token.
 */
export async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenBundle> {
  const url = `${AUTH_BASE}/oauth/token`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    // Best-effort body read for the error message; we deliberately do NOT
    // surface the request body (which would leak `code`).
    let detail = '';
    try {
      detail = (await res.body.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`token exchange failed: HTTP ${res.statusCode}${detail ? ` — ${detail}` : ''}`);
  }
  const payload = (await res.body.json()) as Partial<TokenBundle>;
  if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== 'number') {
    throw new Error(
      'token exchange response is missing required fields (access_token / refresh_token / expires_in)',
    );
  }
  return payload as TokenBundle;
}

/**
 * Decodes the middle (payload) segment of a JWT for *display* only. The
 * signature is NEVER verified — we don't have Auth0's signing key, and the
 * decoded `sub` / `email` are only ever printed back to the user, never used
 * to authorise anything.
 *
 * Returns `null` for any decoding error (malformed JWT, non-JSON payload, …).
 */
export function decodeIdTokenPayload(jwt: string): { sub?: string; email?: string } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const seg = parts[1];
    if (!seg) return null;
    const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
    const raw = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(raw) as { sub?: string; email?: string };
    return obj;
  } catch {
    return null;
  }
}

/**
 * Registers `wabe login <provider>`. Currently only `homegate` is supported.
 *
 * Interactive OOB OAuth2 + PKCE flow:
 *   1. Generate PKCE + state.
 *   2. Print the `/authorize` URL — user opens it in a browser, signs in,
 *      and pastes back the `homegate://login/redirect?...` URL their browser
 *      tried to navigate to.
 *   3. Validate state + extract code.
 *   4. POST to `/oauth/token` to exchange code → access + refresh tokens.
 *   5. Persist via `setHomegateTokens` (atomic, 0600).
 *
 * Security: no token contents, no `code` param, no raw JWT — ever — are
 * written to the log. Only `sub` / `email` (from the unverified id_token) and
 * `expires_in` are printed.
 */
export function registerLogin(prog: Command): void {
  prog
    .command('login <provider>')
    .description('Interactive OAuth2 + PKCE login (provider: homegate)')
    .action(async (provider: string) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });

      if (provider !== 'homegate') {
        console.error(`unknown provider "${provider}" — supported: homegate`);
        process.exit(1);
      }

      p.intro('login → homegate');

      const pkce = generatePkce();
      const url = buildAuthorizeUrl(pkce);

      p.note(
        `Open this URL in a browser, sign in with your Homegate account, and authorise the request:\n\n${url}\n\nThe browser will then try to redirect to "homegate://login/redirect?...".\nThat redirect will fail (it's an iOS app scheme) — that's expected.\nCopy the FULL URL from your browser's address bar and paste it below.`,
        'authorize',
      );

      const pasted = await p.text({
        message: 'Paste the FULL redirect URL (starts with homegate://login/redirect?)',
        validate: (v) => {
          if (!v) return 'cannot be empty';
          if (!v.startsWith('homegate://login/redirect?')) {
            return 'must start with "homegate://login/redirect?"';
          }
          return undefined;
        },
      });
      if (p.isCancel(pasted)) {
        p.cancel('login aborted');
        process.exit(1);
      }

      let code: string;
      try {
        ({ code } = parseRedirectUrl(String(pasted), pkce.state));
      } catch (e) {
        p.cancel((e as Error).message);
        process.exit(1);
      }

      const spin = p.spinner();
      spin.start('exchanging code for tokens');
      let tokens: TokenBundle;
      try {
        tokens = await exchangeCodeForTokens(code, pkce.verifier);
      } catch (e) {
        spin.stop('token exchange failed');
        p.cancel((e as Error).message);
        process.exit(1);
      }
      spin.stop('token exchange ok');

      const identity = tokens.id_token ? decodeIdTokenPayload(tokens.id_token) : null;
      const sub = identity?.sub;
      const email = identity?.email;

      await setHomegateTokens(paths.dataDir, {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        idToken: tokens.id_token,
        userSub: sub,
        loggedInAt: Date.now(),
      });

      const who = email ?? sub ?? 'unknown user';
      p.outro(`✓ logged in as ${who} (access token expires in ${tokens.expires_in}s)`);
    });
}
