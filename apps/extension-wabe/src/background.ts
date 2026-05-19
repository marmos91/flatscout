export {};

/**
 * Wabe Bridge — service worker / event page.
 *
 * Two paths, feature-detected at load time:
 *
 *  - **Chrome (HAS_OFFSCREEN):** the SW does NOT own a WebSocket. A long-lived
 *    offscreen document (see `offscreen.ts`) holds the WS to the local
 *    `@wabe/browser-bridge` server and proxies each request through the SW
 *    via `chrome.runtime.sendMessage({ type: 'wabe-bridge:proxy' })`. The SW
 *    only runs the per-request `chrome.scripting.executeScript` and forwards
 *    `wabe-bridge:reconnect` from the popup down to the offscreen doc.
 *
 *  - **Firefox (no offscreen API):** the existing SW+alarm behavior — the
 *    background page owns the WS directly, with a 1-minute keepalive alarm
 *    re-running `connect()` and writing `lastAliveAt`.
 *
 * Per-request flow is identical on both: open / reuse a hidden tab at the
 * target origin's homepage, then `chrome.scripting.executeScript({ world:
 * 'MAIN', func: inPageFetch })` so DataDome / Cloudflare client-side JS can
 * sign the request normally.
 */

// --------- Shared constants ---------

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const PROTOCOL_VERSION = 1;
const KEEPALIVE_ALARM = 'wabe-bridge-keepalive';
// 30s ticks — Firefox alarm minimum for unpacked/dev extensions. Belt-and-suspenders
// to `persistent: true` in the Firefox manifest: even if the event page sleeps,
// the alarm wakes it inside the bridge daemon's 15s heartbeat stale-window.
const KEEPALIVE_MIN = 0.5;
const MAX_RECONNECT_DELAY_MS = 30_000;
const OFFSCREEN_URL = 'src/offscreen.html';

// --------- Shared tab helpers ---------

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
    // `pinned: true` collapses the tab to its favicon at the left of the tab
    // strip. Chrome MV3 has no real `tabs.hide()` API (Firefox-only), so this
    // is the minimum-footprint option: small, recognisable, and resistant
    // to accidental close.
    const tab = await chrome.tabs.create({ url: homepage, active: false, pinned: true });
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

// --------- Per-request proxy (used by Chrome onMessage AND Firefox proxyRequest) ---------

async function executeProxyRequest(msg: BridgeRequestMessage): Promise<InPageFetchResult> {
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
  return exec.result as InPageFetchResult;
}

// --------- Stats / recent-requests recorder (shared by both paths) ---------

const MAX_RECENT_REQUESTS = 5;
const MAX_ERROR_MESSAGE_LEN = 200;

interface RecentRequestEntry {
  at: number;
  method: string;
  host: string;
  status: number;
  ms: number;
  errored: boolean;
}

interface BridgeStats {
  statsDay: string;
  requestsToday: number;
  errorsToday: number;
  lastErrorAt?: number;
  lastErrorMessage?: string;
  recentRequests: RecentRequestEntry[];
}

interface RecordRequestPayload {
  method: string;
  url: string;
  status: number;
  ms: number;
  errorMessage?: string;
}

function todayString(): string {
  // Use local date — popup also runs in local TZ, so day rollover is consistent.
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

async function recordRequestStats(payload: RecordRequestPayload): Promise<void> {
  const stored = await chrome.storage.local.get('bridgeStats');
  const today = todayString();
  const existing = (stored.bridgeStats as BridgeStats | undefined) ?? {
    statsDay: today,
    requestsToday: 0,
    errorsToday: 0,
    recentRequests: [],
  };
  let stats: BridgeStats =
    existing.statsDay === today
      ? existing
      : {
          statsDay: today,
          requestsToday: 0,
          errorsToday: 0,
          recentRequests: existing.recentRequests ?? [],
        };

  const ok = payload.status >= 200 && payload.status < 300 && !payload.errorMessage;
  const now = Date.now();
  if (ok) {
    stats.requestsToday += 1;
  } else {
    stats.errorsToday += 1;
    stats.lastErrorAt = now;
    stats.lastErrorMessage = (payload.errorMessage ?? `HTTP ${payload.status}`).slice(
      0,
      MAX_ERROR_MESSAGE_LEN,
    );
  }

  const entry: RecentRequestEntry = {
    at: now,
    method: payload.method,
    host: safeHost(payload.url),
    status: payload.status,
    ms: payload.ms,
    errored: !ok,
  };
  stats = {
    ...stats,
    recentRequests: [entry, ...(stats.recentRequests ?? [])].slice(0, MAX_RECENT_REQUESTS),
  };

  await chrome.storage.local.set({ bridgeStats: stats, lastRequestAt: now });
}

// --------- Path selection ---------

const HAS_OFFSCREEN = typeof (chrome as typeof chrome & { offscreen?: unknown }).offscreen !== 'undefined';

if (HAS_OFFSCREEN) {
  installChromePath();
} else {
  installFirefoxPath();
}

// --------- Chrome path ---------

let offscreenCreating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const offscreenAny = (
    chrome as typeof chrome & {
      offscreen: {
        hasDocument(): Promise<boolean>;
        createDocument(opts: {
          url: string;
          reasons: string[];
          justification: string;
        }): Promise<void>;
      };
    }
  ).offscreen;
  if (await offscreenAny.hasDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = offscreenAny
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'persistent WebSocket to local Wabe agent',
    })
    .catch((err: Error) => {
      // Concurrent callers raced through `hasDocument()`; another won.
      // Chrome surfaces this as "Only a single offscreen document may be created."
      if (!/single offscreen document/i.test(err.message)) throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

/**
 * Open a hidden tab at each registered homepage so DataDome can run its
 * challenge and stamp cookies before the first bridge request arrives.
 * `ensureTabForOrigin` dedups via `findExistingTabForOrigin`, so calling
 * it for both `www.X.ch` and `api.X.ch` is safe — the second call returns
 * the same tab the first opened.
 */
async function prewarmTabs(): Promise<void> {
  for (const origin of Object.keys(TAB_HOMEPAGE)) {
    try {
      await ensureTabForOrigin(origin);
    } catch (err) {
      console.warn(`[wabe-bridge] prewarm ${origin} failed: ${(err as Error).message}`);
    }
  }
}

function installChromePath(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void ensureOffscreen();
    void prewarmTabs();
  });
  chrome.runtime.onStartup.addListener(() => {
    void ensureOffscreen();
    void prewarmTabs();
  });
  void ensureOffscreen();
  void prewarmTabs();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'wabe-bridge:proxy') {
      // Self-heal: offscreen may have been evicted by Chrome low-memory reclaim.
      void ensureOffscreen()
        .then(() => executeProxyRequest(message.payload as BridgeRequestMessage))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true; // async response
    }
    if (message?.type === 'wabe-bridge:reconnect') {
      // Don't forward — the popup's sendMessage already broadcasts to the
      // offscreen document directly. We just ensure offscreen exists in case
      // Chrome evicted it. The offscreen's own onMessage listener handles
      // the reconnect.
      void ensureOffscreen()
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    if (message?.type === 'wabe-bridge:get-config') {
      // Offscreen documents don't have chrome.storage in their subset; proxy.
      void chrome.storage.local
        .get(['bridgeUrl', 'authToken'])
        .then((cfg) => {
          sendResponse({
            bridgeUrl: (cfg.bridgeUrl as string | undefined) ?? 'ws://127.0.0.1:8431/bridge',
            token: (cfg.authToken as string | undefined) ?? null,
          });
        })
        .catch(() => sendResponse({ bridgeUrl: 'ws://127.0.0.1:8431/bridge', token: null }));
      return true;
    }
    if (message?.type === 'wabe-bridge:set-state') {
      const payload = (message.payload ?? {}) as {
        lastConnectedAt?: number;
        lastAliveAt?: number;
        lastRequestAt?: number;
      };
      void chrome.storage.local
        .set(payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    if (message?.type === 'wabe-bridge:record-request') {
      const payload = (message.payload ?? {}) as RecordRequestPayload;
      void recordRequestStats(payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    return false;
  });
}

// --------- Firefox path (existing SW + alarm behavior) ---------

function installFirefoxPath(): void {
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

  async function proxyRequest(ws: WebSocket, msg: BridgeRequestMessage): Promise<void> {
    const tStart = Date.now();
    try {
      const out = await executeProxyRequest(msg);
      ws.send(
        JSON.stringify({
          type: 'response',
          id: msg.id,
          status: out.status,
          headers: out.headers,
          body: out.body,
        }),
      );
      await recordRequestStats({
        method: msg.method,
        url: msg.url,
        status: out.status,
        ms: Date.now() - tStart,
      });
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
      await recordRequestStats({
        method: msg.method,
        url: msg.url,
        status: 0,
        ms: Date.now() - tStart,
        errorMessage: e.message,
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
    if (
      state.ws &&
      (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
    ) {
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
      // Clear liveness signals so popup flips to "disconnected" within a
      // render tick instead of waiting for STALE_AFTER_MS to elapse.
      void chrome.storage.local.set({ lastAliveAt: 0, lastConnectedAt: 0, lastRequestAt: 0 });
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
    if (message?.type === 'wabe-bridge:record-request') {
      const payload = (message.payload ?? {}) as RecordRequestPayload;
      void recordRequestStats(payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    return false;
  });

  // Single boot entry point — runs each time the event page wakes from idle.
  // onInstalled/onStartup are kept for the install/Firefox-startup paths but
  // rely on the same `connect()` mutex, so racing is harmless.
  chrome.runtime.onInstalled.addListener(() => {
    void connect();
    void prewarmTabs();
  });
  chrome.runtime.onStartup.addListener(() => {
    void connect();
    void prewarmTabs();
  });
  void prewarmTabs();

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      void chrome.storage.local.set({ lastAliveAt: Date.now() });
    } else {
      void connect();
    }
  });

  void connect();
}
