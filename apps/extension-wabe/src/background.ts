export {};

/**
 * Wabe Bridge — service worker.
 *
 * Holds a single WebSocket to the local `@wabe/browser-bridge` server. On
 * receipt of a `request` message, performs `fetch()` with `credentials: 'include'`
 * (so the host's session cookies are attached) and ships the response back.
 *
 * Forbidden request headers (Host, Origin, Cookie, Referer, …) are silently
 * stripped by the browser — we forward whatever the server sends; the browser
 * enforces its own policy.
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const KEEPALIVE_ALARM = 'wabe-bridge-keepalive';
const KEEPALIVE_MIN = 0.5; // 30 seconds
const MAX_RECONNECT_DELAY_MS = 30_000;

interface State {
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const state: State = { ws: null, reconnectDelayMs: 1_000, reconnectTimer: null };
const EXT_VERSION = chrome.runtime.getManifest().version;

async function readConfig(): Promise<{ bridgeUrl: string; token: string | null }> {
  const cfg = await chrome.storage.local.get(['bridgeUrl', 'authToken']);
  return {
    bridgeUrl: (cfg.bridgeUrl as string | undefined) ?? DEFAULT_BRIDGE_URL,
    token: (cfg.authToken as string | undefined) ?? null,
  };
}

function scheduleReconnect(): void {
  if (state.reconnectTimer !== null) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, state.reconnectDelayMs);
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

async function handleBridgeMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: { type?: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'welcome') {
    state.reconnectDelayMs = 1_000;
    await chrome.storage.local.set({ lastConnectedAt: Date.now() });
    console.log('[wabe-bridge] paired with wabe agent');
    return;
  }
  if (msg.type === 'reject') {
    console.warn('[wabe-bridge] rejected by server:', msg.reason);
    ws.close();
    return;
  }
  if (msg.type === 'request') {
    await proxyRequest(ws, msg as unknown as BridgeRequestMessage);
  }
}

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

async function proxyRequest(ws: WebSocket, msg: BridgeRequestMessage): Promise<void> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), msg.timeout_ms ?? 30_000);
  try {
    const res = await fetch(msg.url, {
      method: msg.method,
      headers: msg.headers,
      body: msg.body,
      credentials: 'include',
      signal: ctrl.signal,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    ws.send(
      JSON.stringify({
        type: 'response',
        id: msg.id,
        status: res.status,
        headers,
        body,
      }),
    );
    await chrome.storage.local.set({ lastRequestAt: Date.now() });
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        id: msg.id,
        message: (err as Error).message,
      }),
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function connect(): Promise<void> {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  const { bridgeUrl, token } = await readConfig();
  if (!token) {
    console.log('[wabe-bridge] no auth token yet — open popup to pair');
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(bridgeUrl);
  } catch (err) {
    console.warn('[wabe-bridge] failed to open WS:', (err as Error).message);
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        extension_version: EXT_VERSION,
        auth_token_hex: token,
      }),
    );
  });
  ws.addEventListener('message', (ev) => {
    void handleBridgeMessage(ws, typeof ev.data === 'string' ? ev.data : '');
  });
  ws.addEventListener('close', () => {
    state.ws = null;
    scheduleReconnect();
  });
  ws.addEventListener('error', (ev) => {
    console.warn('[wabe-bridge] WS error', ev);
  });
}

/** Public message contract from the popup. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wabe-bridge:reconnect') {
    if (state.ws) {
      try {
        state.ws.close();
      } catch {
        // ignore
      }
      state.ws = null;
    }
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.reconnectDelayMs = 1_000;
    void connect();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    void connect();
  }
});

// Boot on each SW startup (idempotent).
void connect();
