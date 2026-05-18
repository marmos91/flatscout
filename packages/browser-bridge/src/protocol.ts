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

export const ServerMessage = z.discriminatedUnion('type', [
  ServerWelcome,
  ServerReject,
  BridgeRequest,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion('type', [
  ClientHello,
  BridgeResponse,
  BridgeError,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
