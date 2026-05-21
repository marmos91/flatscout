import { z } from 'zod';

/** Bumped only on incompatible wire changes. Server + extension MUST agree. */
export const PROTOCOL_VERSION = 1;

export const ClientHello = z.object({
  type: z.literal('hello'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  // Bounded to keep already-paired peers from bloating chrome.storage via the
  // peer_attempt echo — the existing client surfaces this verbatim in its
  // popup. 64 chars covers any plausible semver + suffix.
  extension_version: z.string().min(1).max(64),
  /** Hex-encoded shared secret proving the extension was paired with this wabe instance. */
  auth_token_hex: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ClientHello = z.infer<typeof ClientHello>;

/**
 * Per-origin tab configuration pushed from the daemon to the extension at
 * connect time. Lets source plugins (e.g. agency-specific scrapers behind
 * DataDome on their own domain) register the tab homepage + prewarm URLs
 * the extension should use, without baking them into the extension build.
 *
 * Entries arrive on every `welcome` and `heartbeat` (authoritative-set
 * semantics). The extension merges them over the bundled hardcoded defaults.
 */
export const TabOverride = z.object({
  /** Origin to bind, e.g. `https://api.agency-foo.ch`. */
  origin: z.string().regex(/^https?:\/\/[^/]+$/),
  /** Homepage URL the extension should load in the warm tab. */
  homepage: z.string().url(),
  /**
   * Optional in-page GETs run once per tab lifetime, before the first user
   * request fires. Used to resolve DataDome challenges scoped to a different
   * subdomain than the homepage.
   */
  prewarm: z.array(z.string().url()).optional(),
});
export type TabOverride = z.infer<typeof TabOverride>;

export const ServerWelcome = z.object({
  type: z.literal('welcome'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  /**
   * Hex-encoded SHA-256 of the extension's `dist/<browser>/src/background.js`
   * as the daemon sees it on disk. Extensions compare this against their
   * own bundle hash and call `chrome.runtime.reload()` on mismatch — closes
   * the dev-loop "rebuild ext → forget to reload" gap. Optional so older
   * daemons stay compatible.
   */
  bundle_hash: z.string().optional(),
  /** Authoritative list of dynamic tab overrides; merged over the extension's hardcoded defaults. */
  tab_overrides: z.array(TabOverride).optional(),
});
export type ServerWelcome = z.infer<typeof ServerWelcome>;

export const ServerReject = z.object({
  type: z.literal('reject'),
  reason: z.string(),
  /**
   * Optional human-readable detail. Carried verbatim through to the extension
   * popup. Stable enough for end-users to read; the machine-readable reason
   * remains in `reason`.
   */
  detail: z.string().optional(),
});
export type ServerReject = z.infer<typeof ServerReject>;

/**
 * One-shot notification sent to the currently-connected extension when a
 * second extension instance attempts (and is rejected from) connecting with
 * a valid token. Lets the popup surface "another instance tried to connect"
 * without dropping the live session.
 */
export const ServerPeerAttempt = z.object({
  type: z.literal('peer_attempt'),
  /** Version string the peer client sent in its hello. Useful for diagnostics. */
  extension_version: z.string(),
  /** ISO 8601 timestamp of the rejected attempt. */
  at: z.string(),
});
export type ServerPeerAttempt = z.infer<typeof ServerPeerAttempt>;

/**
 * Sequenced pre-read actions executed in MAIN world before reading `js_path`.
 * Used to drive in-tab SPA navigation between reads (e.g. paginate the
 * immoscout24 SRP). All payloads are trusted plugin-supplied JS — never
 * network input — but the length caps below provide a defensive DoS bound on
 * the wire.
 *
 * - `eval` runs an arbitrary JS statement (wrapped in `new Function`). Use
 *   this to dispatch a router action, click a "next page" control, etc.
 * - `wait_for` polls `js_predicate` in MAIN world every `poll_ms` until the
 *   expression returns truthy or `timeout_ms` elapses. Used to gate on the
 *   SPA having hydrated the next page of state.
 */
export const ReadStateAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('eval'),
    /** JS statement evaluated in MAIN world. Trusted — comes from a Wabe plugin, not network input. */
    js: z.string().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal('wait_for'),
    /** JS expression returning a boolean. Trusted — comes from a Wabe plugin, not network input. */
    js_predicate: z.string().min(1).max(2_000),
    timeout_ms: z.number().int().positive().max(30_000).default(10_000),
    poll_ms: z.number().int().positive().max(2_000).default(200),
  }),
]);
export type ReadStateAction = z.infer<typeof ReadStateAction>;

/**
 * Read-state mode: instead of fetching `url`, the extension finds any tab open
 * at `new URL(url).host`, runs any `actions` in order, then executes `js_path`
 * in MAIN world. The expression's value is JSON-stringified into the response
 * body. Used by sources whose portal serves a SPA-emitted XHR that DataDome
 * refuses to replicate via raw fetch (e.g. immoscout24's `/rent?wzip=...`
 * URL). The plugin must accept that the user keeps a real browsing tab open
 * at the portal.
 */
export const ReadStateRequest = z.object({
  /** JS expression evaluated in MAIN world. Trusted — comes from a Wabe plugin, not network input. */
  js_path: z.string().min(1).max(2_000),
  /**
   * Optional pre-read actions executed in order before `js_path` is read.
   * Capped at 8 to keep one read-state turn bounded.
   */
  actions: z.array(ReadStateAction).max(8).optional(),
});
export type ReadStateRequest = z.infer<typeof ReadStateRequest>;

export const BridgeRequest = z.object({
  type: z.literal('request'),
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'DELETE']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().max(60_000).default(30_000),
  /** When set, the extension reads JS state from a matching open tab instead of fetching. */
  read_state: ReadStateRequest.optional(),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export const BridgeResponse = z.object({
  type: z.literal('response'),
  id: z.string().min(1),
  status: z.number().int().min(0).max(599),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(''),
});
export type BridgeResponse = z.infer<typeof BridgeResponse>;

export const BridgeError = z.object({
  type: z.literal('error'),
  id: z.string().min(1),
  message: z.string(),
});
export type BridgeError = z.infer<typeof BridgeError>;

/**
 * Out-of-band heartbeat the daemon emits every ~30s. Carries the current
 * `bundle_hash` (same value sent in `ServerWelcome`) so extensions detect
 * dist updates without reconnecting.
 */
export const ServerHeartbeat = z.object({
  type: z.literal('heartbeat'),
  bundle_hash: z.string().optional(),
  tab_overrides: z.array(TabOverride).optional(),
});
export type ServerHeartbeat = z.infer<typeof ServerHeartbeat>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerWelcome,
  ServerReject,
  ServerHeartbeat,
  ServerPeerAttempt,
  BridgeRequest,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion('type', [ClientHello, BridgeResponse, BridgeError]);
export type ClientMessage = z.infer<typeof ClientMessage>;
