import { z } from 'zod';

/** Bumped only on incompatible wire changes. Server + extension MUST agree. */
export const PROTOCOL_VERSION = 1;

export const ClientHello = z.object({
  type: z.literal('hello'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  extension_version: z.string(),
  /** Hex-encoded shared secret proving the extension was paired with this wabe instance. */
  auth_token_hex: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ClientHello = z.infer<typeof ClientHello>;

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
});
export type ServerWelcome = z.infer<typeof ServerWelcome>;

export const ServerReject = z.object({
  type: z.literal('reject'),
  reason: z.string(),
});
export type ServerReject = z.infer<typeof ServerReject>;

export const BridgeRequest = z.object({
  type: z.literal('request'),
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'HEAD', 'PUT', 'DELETE']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().max(60_000).default(30_000),
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
});
export type ServerHeartbeat = z.infer<typeof ServerHeartbeat>;

export const ServerMessage = z.discriminatedUnion('type', [
  ServerWelcome,
  ServerReject,
  ServerHeartbeat,
  BridgeRequest,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion('type', [ClientHello, BridgeResponse, BridgeError]);
export type ClientMessage = z.infer<typeof ClientMessage>;
