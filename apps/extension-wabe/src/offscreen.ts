export {};

/**
 * Wabe Bridge — offscreen document.
 *
 * Holds the long-lived WebSocket to the local @wabe/browser-bridge server.
 * The MV3 service worker would otherwise suspend after ~30s of idle and kill
 * the socket. The offscreen document does not suspend; it owns the WS for
 * the lifetime of the extension.
 *
 * Per-request flow:
 *  bridge server -> WS (this doc)
 *   -> chrome.runtime.sendMessage({ type: 'wabe-bridge:proxy', payload })
 *     -> background.ts (SW wakes)
 *       -> chrome.scripting.executeScript({ world: 'MAIN' })
 *     <- result
 *   <- sendMessage reply
 *  -> WS response back to bridge server
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const MAX_RECONNECT_DELAY_MS = 30_000;
const LIVENESS_TICK_MS = 10_000;

interface State {
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  everPaired: boolean;
  connecting: boolean;
}

const state: State = {
  ws: null,
  reconnectDelayMs: 1_000,
  reconnectTimer: null,
  everPaired: false,
  connecting: false,
};

// chrome.runtime.getManifest() is not exposed in offscreen documents (the
// offscreen subset of chrome.runtime is limited to sendMessage/connect). The
// version field is purely diagnostic — server doesn't gate on it — so we
// ship a static string from build time.
const EXT_VERSION = '0.0.0';

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

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
}

interface InPageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function proxyRequest(ws: WebSocket, msg: BridgeRequestMessage): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: 'wabe-bridge:proxy',
      payload: msg,
    })) as { ok: true; result: InPageFetchResult } | { ok: false; message: string };
    if (reply?.ok) {
      ws.send(
        JSON.stringify({
          type: 'response',
          id: msg.id,
          status: reply.result.status,
          headers: reply.result.headers,
          body: reply.result.body,
        }),
      );
      await chrome.storage.local.set({ lastRequestAt: Date.now() });
    } else {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: msg.id,
          message: reply?.message ?? 'background proxy failed',
        }),
      );
    }
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        id: msg.id,
        message: (err as Error).message,
      }),
    );
  }
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
    await chrome.storage.local.set({ lastConnectedAt: Date.now(), lastAliveAt: Date.now() });
    if (!state.everPaired) {
      state.everPaired = true;
      console.log('[wabe-bridge:offscreen] paired with wabe agent');
    }
    return;
  }
  if (msg.type === 'reject') {
    console.warn('[wabe-bridge:offscreen] rejected by server:', msg.reason);
    ws.close();
    return;
  }
  if (msg.type === 'request') {
    await proxyRequest(ws, msg as unknown as BridgeRequestMessage);
  }
}

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  state.connecting = true;
  const { bridgeUrl, token } = await readConfig();
  if (!token) {
    state.connecting = false;
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(bridgeUrl);
  } catch (err) {
    state.connecting = false;
    console.warn(`[wabe-bridge:offscreen] failed to open WS: ${(err as Error).message}`);
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  state.connecting = false;
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
  ws.addEventListener('error', () => {
    /* close follows */
  });
}

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

setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    void chrome.storage.local.set({ lastAliveAt: Date.now() });
  }
}, LIVENESS_TICK_MS);

void connect();
