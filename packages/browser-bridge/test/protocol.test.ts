import { describe, expect, it } from 'vitest';
import {
  BridgeError,
  BridgeRequest,
  BridgeResponse,
  ClientHello,
  ClientMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  ServerPeerAttempt,
  ServerReject,
  ServerWelcome,
} from '../src/protocol.js';

describe('PROTOCOL_VERSION', () => {
  it('is 1 for the first wire-compat generation', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('ClientHello', () => {
  it('parses a valid hello', () => {
    const h = ClientHello.parse({
      type: 'hello',
      protocol_version: 1,
      extension_version: '0.0.0',
      auth_token_hex: 'a'.repeat(64),
    });
    expect(h.protocol_version).toBe(1);
  });
  it('rejects wrong protocol version', () => {
    expect(() =>
      ClientHello.parse({
        type: 'hello',
        protocol_version: 2,
        extension_version: '0.0.0',
        auth_token_hex: 'a'.repeat(64),
      }),
    ).toThrow();
  });
  it('rejects non-hex token', () => {
    expect(() =>
      ClientHello.parse({
        type: 'hello',
        protocol_version: 1,
        extension_version: '0.0.0',
        auth_token_hex: 'not-hex-token',
      }),
    ).toThrow();
  });
  it('rejects short token', () => {
    expect(() =>
      ClientHello.parse({
        type: 'hello',
        protocol_version: 1,
        extension_version: '0.0.0',
        auth_token_hex: 'a'.repeat(63),
      }),
    ).toThrow();
  });
  it('rejects an oversized extension_version (storage-bloat bound)', () => {
    // ServerPeerAttempt echoes hello.extension_version verbatim into the
    // existing client's chrome.storage.local — cap the input so a paired peer
    // can't drown the popup with a megabyte of garbage.
    expect(() =>
      ClientHello.parse({
        type: 'hello',
        protocol_version: 1,
        extension_version: 'x'.repeat(65),
        auth_token_hex: 'a'.repeat(64),
      }),
    ).toThrow();
  });
});

describe('ServerWelcome', () => {
  it('parses welcome', () => {
    const w = ServerWelcome.parse({ type: 'welcome', protocol_version: 1 });
    expect(w.protocol_version).toBe(1);
  });

  it('parses welcome with tab_overrides', () => {
    const w = ServerWelcome.parse({
      type: 'welcome',
      protocol_version: 1,
      tab_overrides: [
        { origin: 'https://api.agency-foo.ch', homepage: 'https://agency-foo.ch/' },
        {
          origin: 'https://api.agency-bar.ch',
          homepage: 'https://agency-bar.ch/listings',
          prewarm: ['https://api.agency-bar.ch/geo'],
        },
      ],
    });
    expect(w.tab_overrides).toHaveLength(2);
    expect(w.tab_overrides?.[1]?.prewarm).toEqual(['https://api.agency-bar.ch/geo']);
  });

  it('rejects tab_overrides with invalid origin shape', () => {
    expect(() =>
      ServerWelcome.parse({
        type: 'welcome',
        protocol_version: 1,
        tab_overrides: [{ origin: 'agency-foo.ch', homepage: 'https://agency-foo.ch/' }],
      }),
    ).toThrow();
  });
});

describe('ServerReject', () => {
  it('parses a reject with reason', () => {
    const r = ServerReject.parse({ type: 'reject', reason: 'bad token' });
    expect(r.reason).toBe('bad token');
    expect(r.detail).toBeUndefined();
  });
  it('parses a reject with optional detail', () => {
    const r = ServerReject.parse({
      type: 'reject',
      reason: 'another_client_active',
      detail: 'A bridge client is already connected. Disconnect the other browser extension first.',
    });
    expect(r.reason).toBe('another_client_active');
    expect(r.detail).toMatch(/already connected/);
  });
});

describe('ServerPeerAttempt', () => {
  it('parses a peer_attempt with version + iso timestamp', () => {
    const at = new Date().toISOString();
    const m = ServerPeerAttempt.parse({
      type: 'peer_attempt',
      extension_version: '0.1.2',
      at,
    });
    expect(m.extension_version).toBe('0.1.2');
    expect(m.at).toBe(at);
  });
  it('rejects a peer_attempt missing fields', () => {
    expect(() => ServerPeerAttempt.parse({ type: 'peer_attempt', extension_version: '0.1.2' })).toThrow();
  });
});

describe('BridgeRequest read_state', () => {
  it('accepts a read_state envelope on an otherwise-normal request', () => {
    const r = BridgeRequest.parse({
      type: 'request',
      id: 'r-state-1',
      method: 'GET',
      url: 'https://www.immoscout24.ch/',
      read_state: { js_path: 'window.__INITIAL_STATE__.resultList' },
    });
    expect(r.read_state?.js_path).toBe('window.__INITIAL_STATE__.resultList');
  });

  it('rejects an empty js_path', () => {
    expect(() =>
      BridgeRequest.parse({
        type: 'request',
        id: 'r-state-2',
        method: 'GET',
        url: 'https://www.immoscout24.ch/',
        read_state: { js_path: '' },
      }),
    ).toThrow();
  });

  it('rejects a js_path longer than 2000 chars (DoS bound)', () => {
    expect(() =>
      BridgeRequest.parse({
        type: 'request',
        id: 'r-state-3',
        method: 'GET',
        url: 'https://www.immoscout24.ch/',
        read_state: { js_path: 'x'.repeat(2001) },
      }),
    ).toThrow();
  });
});

describe('BridgeRequest', () => {
  it('parses a GET with default headers + timeout', () => {
    const r = BridgeRequest.parse({
      type: 'request',
      id: 'r-1',
      method: 'GET',
      url: 'https://api.homegate.ch/search/listings?x=1',
    });
    expect(r.id).toBe('r-1');
    expect(r.headers).toEqual({});
    expect(r.timeout_ms).toBe(30_000);
  });
  it('parses a POST with body + custom headers', () => {
    const r = BridgeRequest.parse({
      type: 'request',
      id: 'r-2',
      method: 'POST',
      url: 'https://api.homegate.ch/x',
      headers: { accept: 'application/json' },
      body: '{"a":1}',
      timeout_ms: 5_000,
    });
    expect(r.method).toBe('POST');
    expect(r.body).toBe('{"a":1}');
    expect(r.headers.accept).toBe('application/json');
    expect(r.timeout_ms).toBe(5_000);
  });
  it('rejects unsupported methods', () => {
    expect(() =>
      BridgeRequest.parse({
        type: 'request',
        id: 'r-3',
        method: 'PATCH',
        url: 'https://x/',
      }),
    ).toThrow();
  });
  it('rejects invalid URL', () => {
    expect(() =>
      BridgeRequest.parse({
        type: 'request',
        id: 'r-4',
        method: 'GET',
        url: 'not a url',
      }),
    ).toThrow();
  });
  it('caps timeout_ms at 60s', () => {
    expect(() =>
      BridgeRequest.parse({
        type: 'request',
        id: 'r-5',
        method: 'GET',
        url: 'https://x/',
        timeout_ms: 120_000,
      }),
    ).toThrow();
  });
});

describe('BridgeResponse', () => {
  it('parses a 200 response with body', () => {
    const r = BridgeResponse.parse({
      type: 'response',
      id: 'r-1',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
  });
  it('defaults headers and body when omitted', () => {
    const r = BridgeResponse.parse({ type: 'response', id: 'r-2', status: 204 });
    expect(r.headers).toEqual({});
    expect(r.body).toBe('');
  });
  it('rejects status > 599', () => {
    expect(() => BridgeResponse.parse({ type: 'response', id: 'r-3', status: 600 })).toThrow();
  });
});

describe('BridgeError', () => {
  it('parses an error envelope', () => {
    const e = BridgeError.parse({ type: 'error', id: 'r-1', message: 'boom' });
    expect(e.message).toBe('boom');
  });
});

describe('discriminated unions', () => {
  it('ServerMessage accepts welcome / reject / request / peer_attempt', () => {
    expect(ServerMessage.parse({ type: 'welcome', protocol_version: 1 }).type).toBe('welcome');
    expect(ServerMessage.parse({ type: 'reject', reason: 'x' }).type).toBe('reject');
    expect(
      ServerMessage.parse({
        type: 'request',
        id: 'r-1',
        method: 'GET',
        url: 'https://x/',
      }).type,
    ).toBe('request');
    expect(
      ServerMessage.parse({
        type: 'peer_attempt',
        extension_version: '0.0.1',
        at: '2026-05-21T00:00:00.000Z',
      }).type,
    ).toBe('peer_attempt');
  });
  it('ClientMessage accepts hello / response / error', () => {
    expect(
      ClientMessage.parse({
        type: 'hello',
        protocol_version: 1,
        extension_version: '0',
        auth_token_hex: 'a'.repeat(64),
      }).type,
    ).toBe('hello');
    expect(ClientMessage.parse({ type: 'response', id: 'r', status: 200 }).type).toBe('response');
    expect(ClientMessage.parse({ type: 'error', id: 'r', message: 'x' }).type).toBe('error');
  });
});
