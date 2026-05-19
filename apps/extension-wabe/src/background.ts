export {};

/**
 * Wabe Bridge — service worker / event page.
 *
 * Holds a single WebSocket to the local `@wabe/browser-bridge` server. Bridge
 * requests are not performed via the SW's own `fetch()` (which goes out as
 * the extension origin and bypasses any anti-bot JS hook on the target page).
 * Instead, a hidden tab is opened per target origin (`https://www.homegate.ch`,
 * `https://www.immoscout24.ch`, …); `chrome.scripting.executeScript` injects
 * a `fetch()` call into the tab's MAIN world. DataDome's `fetch` hook runs
 * normally, adds the JS-challenge-derived header, and the upstream sees a
 * legitimate web-app request.
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const KEEPALIVE_ALARM = 'wabe-bridge-keepalive';
const KEEPALIVE_MIN = 0.5;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Per-target-origin warm-tab map. Each origin gets exactly one tab; we
 * recreate it lazily on removal. The tab loads the origin's "/" so DataDome
 * can run its challenge and stamp cookies before any bridge request hits.
 */
const TAB_HOMEPAGE: Record<string, string> = {
  'https://www.homegate.ch': 'https://www.homegate.ch/rent',
  'https://api.homegate.ch': 'https://www.homegate.ch/rent',
  'https://www.immoscout24.ch': 'https://www.immoscout24.ch/en/real-estate/rent/city-zurich',
  'https://api.immoscout24.ch': 'https://www.immoscout24.ch/en/real-estate/rent/city-zurich',
};

/** In-flight tab-ready promises, dedup parallel requests for the same origin. */
const tabReady = new Map<string, Promise<number>>();

function originFromHostUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function urlMatchPattern(origin: string): string {
  // chrome.tabs.query needs a match pattern, not a literal origin.
  return `${origin}/*`;
}

async function findExistingTabForOrigin(origin: string): Promise<number | null> {
  // Tabs for an "origin" are queried against the HOMEPAGE we open for that
  // group (e.g. requests to api.homegate.ch route through a tab loaded at
  // www.homegate.ch/rent). Search the homepage's host pattern so we share one
  // tab across the whole site family.
  const homepageUrl = TAB_HOMEPAGE[origin] ?? `${origin}/`;
  const homepageHost = new URL(homepageUrl).host;
  const pattern = `*://${homepageHost}/*`;
  const tabs = await chrome.tabs.query({ url: pattern });
  for (const t of tabs) {
    if (t.id !== undefined && t.status === 'complete') return t.id;
  }
  for (const t of tabs) {
    if (t.id !== undefined) return t.id;
  }
  // Also accept any direct match on the target origin (covers manual override).
  const direct = await chrome.tabs.query({ url: urlMatchPattern(origin) });
  for (const t of direct) {
    if (t.id !== undefined && t.status === 'complete') return t.id;
  }
  return null;
}

interface State {
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  everPaired: boolean;
  /** True while a connect() call is constructing a WebSocket; prevents parallel sockets. */
  connecting: boolean;
}

const state: State = {
  ws: null,
  reconnectDelayMs: 1_000,
  reconnectTimer: null,
  everPaired: false,
  connecting: false,
};

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

/**
 * Returns the tab id loaded at `${origin}/`-something, creating + waiting for
 * it on first request. Subsequent requests reuse the same tab so the page's
 * DataDome session persists.
 */
async function ensureTabForOrigin(origin: string): Promise<number> {
  // Always query browser state — SW suspension makes in-memory caching unreliable.
  const existing = await findExistingTabForOrigin(origin);
  if (existing !== null) {
    const tab = await getTab(existing).catch(() => null);
    if (tab && tab.status === 'complete') return existing;
    if (tab) {
      await waitForTabComplete(existing);
      return existing;
    }
  }
  const pending = tabReady.get(origin);
  if (pending) return pending;
  const homepage = TAB_HOMEPAGE[origin] ?? `${origin}/`;
  const p = (async (): Promise<number> => {
    const tab = await chrome.tabs.create({ url: homepage, active: false });
    if (tab.id === undefined) throw new Error('tab created with no id');
    await waitForTabComplete(tab.id);
    return tab.id;
  })();
  tabReady.set(origin, p);
  try {
    return await p;
  } finally {
    tabReady.delete(origin);
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} did not reach 'complete' within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id !== tabId) return;
      if (info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Catch the case where the tab is already 'complete' before we attached.
    getTab(tabId)
      .then((t) => {
        if (t.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(() => {
        // Tab may have been closed underneath us — let the timer surface it.
      });
  });
}

function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    chrome.tabs.get(tabId, (tab: chrome.tabs.Tab | undefined) => {
      const err = chrome.runtime.lastError;
      if (err || !tab) {
        reject(new Error(err?.message ?? `tab ${tabId} not found`));
        return;
      }
      resolve(tab);
    });
  });
}

// no in-memory tab map — every request re-queries via chrome.tabs.query.
// (originFromHostUrl is only used inside proxyRequest below.)
void originFromHostUrl;

interface InPageFetchArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

interface InPageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Executed in the tab's MAIN world. Uses the page's hooked `fetch` so
 * DataDome / Cloudflare client-side JS can sign the request normally.
 *
 * NOTE: kept self-contained — no closure over background scope (executeScript
 * serialises the function).
 */
async function inPageFetch(args: InPageFetchArgs): Promise<InPageFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    // NOTE: deliberately omit `credentials` here. api.homegate.ch returns
    // `Access-Control-Allow-Origin: *`, which the CORS spec forbids pairing
    // with credentialed requests. The web app makes anonymous calls too —
    // DataDome's JS hook signs them via a request header, not via cookies on
    // the api subdomain.
    const init: RequestInit = {
      method: args.method,
      headers: args.headers,
      signal: ctrl.signal,
    };
    if (args.body !== undefined) init.body = args.body;
    const res = await fetch(args.url, init);
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body: text };
  } finally {
    clearTimeout(t);
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
  const tStart = Date.now();
  try {
    const targetOrigin = new URL(msg.url).origin;
    const tabId = await ensureTabForOrigin(targetOrigin);
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: inPageFetch,
      args: [
        {
          method: msg.method,
          url: msg.url,
          headers: msg.headers ?? {},
          body: msg.body,
          timeoutMs: msg.timeout_ms ?? 30_000,
        },
      ],
    });
    if (!exec || exec.result === undefined) {
      throw new Error('executeScript returned no result');
    }
    const out = exec.result as InPageFetchResult;
    ws.send(
      JSON.stringify({
        type: 'response',
        id: msg.id,
        status: out.status,
        headers: out.headers,
        body: out.body,
      }),
    );
    await chrome.storage.local.set({ lastRequestAt: Date.now() });
  } catch (err) {
    const e = err as Error;
    console.warn(
      `[wabe-bridge] request ${msg.id.slice(0, 8)} failed after ${Date.now() - tStart}ms: ${e.message}`,
    );
    ws.send(
      JSON.stringify({
        type: 'error',
        id: msg.id,
        message: e.message,
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
    await chrome.storage.local.set({ lastConnectedAt: Date.now() });
    // Log only on first welcome of a session; the rest are alarm-driven
    // reconnects after SW suspension and would otherwise spam the console.
    if (!state.everPaired) {
      state.everPaired = true;
      console.log('[wabe-bridge] paired with wabe agent');
    }
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

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return; // already have a live or in-flight socket
  }
  state.connecting = true;
  const { bridgeUrl, token } = await readConfig();
  if (!token) {
    state.connecting = false;
    return; // popup will message us once paired
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(bridgeUrl);
  } catch (err) {
    state.connecting = false;
    console.warn(`[wabe-bridge] failed to open WS: ${(err as Error).message}`);
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
    // Network failures will surface via the subsequent close event; no need to log twice.
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

// Single boot entry point — runs each time the event page wakes from idle.
// onInstalled/onStartup are kept for the install/Firefox-startup paths but
// rely on the same `connect()` mutex, so racing is harmless.
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

void connect();
