/**
 * Auth0 / Homegate OAuth2 constants — captured from the iOS app.
 *
 * Single source of truth for the wire-level "what an HG client looks like"
 * shape. Both `auth.ts` (refresh-token rotation, plugin-side) and
 * `@wabe/cli`'s login/logout commands (interactive OAuth, CLI-side) import
 * from here so the two paths never drift.
 *
 * Plugins can't depend on `@wabe/server` (server is the loader), so this
 * module is the shared layer instead.
 */
export const AUTH_BASE = 'https://auth.homegate.ch';
export const CLIENT_ID = 'lU7SBprOA383MV4TCsRfP9wUPc4JAcy1';
export const REDIRECT_URI = 'homegate://login/redirect';
export const SCOPE = 'openid profile email offline_access';
export const AUDIENCE = 'https://api.homegate.ch';
