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
  /** Set when daemon rejected us with `another_client_active`. Muted until popup-driven reconnect. */
  blocked: boolean;
}

const state: State = {
  ws: null,
  reconnectDelayMs: 1_000,
  reconnectTimer: null,
  everPaired: false,
  connecting: false,
  blocked: false,
};

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  read_state?: { js_path: string };
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

/** Fire-and-forget. SW persists overrides + reprewarms newly-registered tabs. */
function forwardTabOverrides(overrides: unknown[]): void {
  void chrome.runtime.sendMessage({ type: 'wabe-bridge:set-tab-overrides', payload: overrides }).catch(() => {
    /* SW may be busy; the next heartbeat re-pushes the same list */
  });
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

/** Fire-and-forget. SW merges into chrome.storage.local.bridgeStats. */
function recordRequest(payload: {
  method: string;
  url: string;
  status: number;
  ms: number;
  errorMessage?: string;
}): void {
  void chrome.runtime.sendMessage({ type: 'wabe-bridge:record-request', payload }).catch(() => {
    /* SW may be busy; loss of a single stats record is non-fatal */
  });
}

function scheduleReconnect(): void {
  if (state.reconnectTimer !== null) return;
  if (state.blocked) return; // wait for explicit popup-driven Reconnect
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
      const elapsed = Date.now() - t0;
      console.log(
        `[wabe-bridge:offscreen] proxy ok ${reply.result.status} (${elapsed}ms) ${msg.id.slice(0, 8)}`,
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
      recordRequest({
        method: msg.method,
        url: msg.url,
        status: reply.result.status,
        ms: elapsed,
      });
    } else {
      const elapsed = Date.now() - t0;
      const message = reply?.message ?? 'background proxy failed';
      console.warn(`[wabe-bridge:offscreen] proxy fail ${message} (${elapsed}ms)`);
      safeSend(
        ws,
        JSON.stringify({
          type: 'error',
          id: msg.id,
          message,
        }),
      );
      recordRequest({
        method: msg.method,
        url: msg.url,
        status: 0,
        ms: elapsed,
        errorMessage: message,
      });
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    const message = (err as Error).message;
    console.warn(`[wabe-bridge:offscreen] proxy threw: ${message}`);
    safeSend(
      ws,
      JSON.stringify({
        type: 'error',
        id: msg.id,
        message,
      }),
    );
    recordRequest({
      method: msg.method,
      url: msg.url,
      status: 0,
      ms: elapsed,
      errorMessage: message,
    });
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
    if (typeof msg.bundle_hash === 'string') {
      void maybeSelfReload(msg.bundle_hash);
    }
    if (Array.isArray(msg.tab_overrides)) {
      forwardTabOverrides(msg.tab_overrides);
    }
    return;
  }
  if (msg.type === 'heartbeat') {
    if (typeof msg.bundle_hash === 'string') {
      void maybeSelfReload(msg.bundle_hash);
    }
    if (Array.isArray(msg.tab_overrides)) {
      forwardTabOverrides(msg.tab_overrides);
    }
    return;
  }
  if (msg.type === 'reject') {
    const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown';
    const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
    console.warn('[wabe-bridge:offscreen] rejected by server:', reason, detail ?? '');
    if (reason === 'another_client_active') {
      state.blocked = true;
      // Tell the SW to persist the block + cancel any pending reconnect.
      // If this send fails the SW won't know we're blocked, so the popup
      // won't see a reason for the disconnect — log so a maintainer
      // tailing the offscreen console at least has a breadcrumb. The
      // popup-driven reconnect path is the user's recovery; there is no
      // automatic retry because the very next reconnect would just be
      // preempted again.
      void chrome.runtime
        .sendMessage({
          type: 'wabe-bridge:set-blocked',
          payload: { reason, detail: detail ?? null, at: Date.now() },
        })
        .catch((err: Error) => {
          console.warn(`[wabe-bridge] offscreen failed to notify SW of block: ${err.message}`);
        });
      if (state.reconnectTimer !== null) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
    }
    ws.close();
    return;
  }
  if (msg.type === 'peer_attempt') {
    const at = typeof msg.at === 'string' ? msg.at : new Date().toISOString();
    const peerVersion = typeof msg.extension_version === 'string' ? msg.extension_version : 'unknown';
    void chrome.runtime
      .sendMessage({
        type: 'wabe-bridge:set-peer-attempt',
        payload: { at, extension_version: peerVersion },
      })
      .catch(() => {
        /* non-fatal */
      });
    return;
  }
  if (msg.type === 'keepalive') {
    recordState({ lastAliveAt: Date.now() });
    return;
  }
  if (msg.type === 'request') {
    await proxyRequest(ws, msg as unknown as BridgeRequestMessage);
  }
}

/**
 * Self-reload when the daemon-reported background.js hash diverges from
 * ours. Chrome's `chrome.runtime.reload()` is callable from offscreen
 * documents and tears down everything (offscreen included), then Chrome
 * spawns the SW + offscreen fresh against the new dist.
 */
let selfBundleHash: string | null = null;
async function getSelfBundleHash(): Promise<string | null> {
  if (selfBundleHash) return selfBundleHash;
  try {
    const url = chrome.runtime.getURL('src/background.js');
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    selfBundleHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return selfBundleHash;
  } catch (err) {
    console.warn('[wabe-bridge:offscreen] failed to hash own bundle:', (err as Error).message);
    return null;
  }
}

let reloadScheduled = false;
async function maybeSelfReload(daemonHash: string): Promise<void> {
  if (reloadScheduled) return;
  const own = await getSelfBundleHash();
  if (!own || own === daemonHash) return;
  reloadScheduled = true;
  console.log(
    `[wabe-bridge:offscreen] bundle hash drifted (own=${own.slice(0, 8)} daemon=${daemonHash.slice(0, 8)}); requesting reload`,
  );
  // Offscreen documents don't have `chrome.runtime.reload` — delegate to the
  // service worker, which holds the full chrome.runtime surface.
  setTimeout(() => {
    void chrome.runtime.sendMessage({ type: 'wabe-bridge:reload-extension' }).catch((err: Error) => {
      console.warn('[wabe-bridge:offscreen] reload request failed:', err.message);
    });
  }, 250);
}

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (state.blocked) return; // wait for explicit popup-driven Reconnect
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
    // Clear all liveness signals so popup flips to "disconnected" within one
    // render tick instead of waiting for STALE_AFTER_MS wall-clock to elapse.
    // Popup takes Math.max of all three — clearing only one leaves popup
    // anchored to the older surviving value.
    recordState({ lastAliveAt: 0, lastConnectedAt: 0, lastRequestAt: 0 });
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
    // Explicit popup-driven reconnect — clear the single-client block.
    state.blocked = false;
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
