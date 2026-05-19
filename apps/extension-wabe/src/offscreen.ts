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
 *
 * IMPORTANT: chrome.storage and chrome.runtime.getManifest are NOT in the
 * offscreen-document chrome.* subset. All persistent state is fetched from
 * and written to chrome.storage.local indirectly via runtime.sendMessage to
 * the SW (background.ts).
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const MAX_RECONNECT_DELAY_MS = 30_000;
const LIVENESS_TICK_MS = 10_000;
const EXT_VERSION = '0.0.0';

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

interface ConfigReply {
  bridgeUrl: string;
  token: string | null;
}

async function readConfig(): Promise<ConfigReply> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: 'wabe-bridge:get-config' })) as
      | ConfigReply
      | undefined;
    if (reply && typeof reply === 'object') {
      return {
        bridgeUrl: reply.bridgeUrl ?? DEFAULT_BRIDGE_URL,
        token: reply.token ?? null,
      };
    }
  } catch (err) {
    console.warn(`[wabe-bridge:offscreen] get-config failed: ${(err as Error).message}`);
  }
  return { bridgeUrl: DEFAULT_BRIDGE_URL, token: null };
}

/** Fire-and-forget. SW writes to chrome.storage.local on our behalf. */
function recordState(patch: {
  lastConnectedAt?: number;
  lastAliveAt?: number;
  lastRequestAt?: number;
}): void {
  void chrome.runtime.sendMessage({ type: 'wabe-bridge:set-state', payload: patch }).catch(() => {
    /* SW may be busy; popup still reads via SW on next render */
  });
}

function scheduleReconnect(): void {
  if (state.reconnectTimer !== null) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, state.reconnectDelayMs);
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

function safeSend(ws: WebSocket, payload: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[wabe-bridge:offscreen] dropping send: WS not OPEN');
    forceReconnect();
    return false;
  }
  try {
    ws.send(payload);
    return true;
  } catch (err) {
    console.warn(`[wabe-bridge:offscreen] ws.send threw: ${(err as Error).message}`);
    forceReconnect();
    return false;
  }
}

function forceReconnect(): void {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.reconnectDelayMs = 1_000;
  void connect();
}

async function proxyRequest(ws: WebSocket, msg: BridgeRequestMessage): Promise<void> {
  const t0 = Date.now();
  console.log(`[wabe-bridge:offscreen] proxy ${msg.method} ${msg.url.slice(0, 80)}`);
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: 'wabe-bridge:proxy',
      payload: msg,
    })) as { ok: true; result: InPageFetchResult } | { ok: false; message: string };
    if (reply?.ok) {
      console.log(
        `[wabe-bridge:offscreen] proxy ok ${reply.result.status} (${Date.now() - t0}ms) ${msg.id.slice(0, 8)}`,
      );
      safeSend(
        ws,
        JSON.stringify({
          type: 'response',
          id: msg.id,
          status: reply.result.status,
          headers: reply.result.headers,
          body: reply.result.body,
        }),
      );
      recordState({ lastRequestAt: Date.now() });
    } else {
      console.warn(
        `[wabe-bridge:offscreen] proxy fail ${reply?.message ?? '(no message)'} (${Date.now() - t0}ms)`,
      );
      safeSend(
        ws,
        JSON.stringify({
          type: 'error',
          id: msg.id,
          message: reply?.message ?? 'background proxy failed',
        }),
      );
    }
  } catch (err) {
    console.warn(`[wabe-bridge:offscreen] proxy threw: ${(err as Error).message}`);
    safeSend(
      ws,
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
    recordState({ lastConnectedAt: Date.now(), lastAliveAt: Date.now() });
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
    recordState({ lastAliveAt: Date.now() });
  }
}, LIVENESS_TICK_MS);

void connect();
