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
// Ask for 15s ticks. Firefox MV3 clamps to a minimum of 0.5 (30s) for
// unpacked extensions and 1.0 (60s) for packed, so the effective period is
// at least 30s. Combined with the 5s in-page setInterval below, this gives
// both a wake-up path (alarm, while suspended) AND a fast in-page heartbeat
// (setInterval, while alive) so the WS sees activity every few seconds.
const KEEPALIVE_MIN = 0.25;
// In-page heartbeat interval — sends `{type:'ping'}` to the server every
// few seconds while the event page is alive. Resets Firefox's idle
// suspension timer (it counts setInterval callbacks + WS writes as activity).
const IN_PAGE_PING_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const OFFSCREEN_URL = 'src/offscreen.html';

// --------- Shared tab helpers ---------

/**
 * Per-target-origin warm-tab config. Each origin gets exactly one tab; we
 * recreate it lazily on removal. The tab loads `homepage` so DataDome can
 * run its challenge and stamp cookies before any bridge request hits.
 *
 * `prewarm` lists URLs to GET (via in-page fetch) once per tab lifetime,
 * before the first user-driven request fires. Use this when the target API
 * lives on a subdomain whose DataDome challenge differs from the homepage
 * subdomain (e.g. `api.immoscout24.ch` vs `www.immoscout24.ch`) — the first
 * cross-origin call from the page would otherwise NetworkError before the
 * challenge can resolve.
 */
interface TabHomepageConfig {
  homepage: string;
  prewarm?: string[];
}
const DEFAULT_TAB_HOMEPAGE: Record<string, TabHomepageConfig> = {
  'https://www.homegate.ch': { homepage: 'https://www.homegate.ch/rent' },
  'https://api.homegate.ch': { homepage: 'https://www.homegate.ch/rent' },
  'https://www.immoscout24.ch': {
    homepage: 'https://www.immoscout24.ch/en/real-estate/rent/city-zurich',
  },
  'https://api.immoscout24.ch': {
    homepage: 'https://www.immoscout24.ch/en/real-estate/rent/city-zurich',
  },
};

/**
 * Runtime overrides pushed by the daemon over the bridge's `welcome` /
 * `heartbeat` messages. Each push is authoritative — we replace the whole
 * map. Persisted to chrome.storage.local so the SW survives suspension
 * without dropping registrations.
 */
let dynamicTabOverrides: Record<string, TabHomepageConfig> = {};

function lookupTabHomepage(origin: string): TabHomepageConfig | undefined {
  return dynamicTabOverrides[origin] ?? DEFAULT_TAB_HOMEPAGE[origin];
}

interface IncomingTabOverride {
  origin: string;
  homepage: string;
  prewarm?: string[];
}

function applyTabOverrides(overrides: readonly IncomingTabOverride[]): void {
  const next: Record<string, TabHomepageConfig> = {};
  for (const o of overrides) {
    if (typeof o?.origin === 'string' && typeof o?.homepage === 'string') {
      next[o.origin] = { homepage: o.homepage, ...(o.prewarm ? { prewarm: o.prewarm } : {}) };
    }
  }
  dynamicTabOverrides = next;
  // Invalidate prewarm cache for any tabs whose origin's prewarm list changed —
  // simplest correct approach is to clear all; re-prewarms are cheap and
  // overrides land at most once per daemon connect.
  prewarmedTabs.clear();
  void chrome.storage.local.set({ tabOverrides: next }).catch(() => {
    /* storage write failures are non-fatal; next push will retry */
  });
}

async function loadPersistedTabOverrides(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get('tabOverrides');
    const obj = stored.tabOverrides as Record<string, TabHomepageConfig> | undefined;
    if (obj && typeof obj === 'object') {
      dynamicTabOverrides = obj;
    }
  } catch {
    /* ignore — first boot has no entry */
  }
}

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
  const homepageUrl = lookupTabHomepage(origin)?.homepage ?? `${origin}/`;
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
  const homepage = lookupTabHomepage(origin)?.homepage ?? `${origin}/`;
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
    let res: Response;
    try {
      res = await fetch(args.url, init);
    } catch (err) {
      // CORS errors, network errors, DataDome challenge interception failures
      // — surface them as a structured response instead of letting the throw
      // propagate out of `executeScript` as a generic "no result" failure.
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 0, headers: {}, body: `inPageFetch error: ${msg}` };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: res.status, headers: {}, body: `inPageFetch body-read error: ${msg}` };
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body: text };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Per-tab record of which prewarm URLs we've already executed. Cleared on
 * tab close. The contract is "once per tab lifetime" — if DataDome later
 * expires the challenge state, the tab will close and a fresh one with a
 * fresh prewarm run takes its place.
 */
const prewarmedTabs = new Map<number, Set<string>>();

async function ensureRequestPrewarm(tabId: number, origin: string): Promise<void> {
  const cfg = lookupTabHomepage(origin);
  if (!cfg?.prewarm?.length) return;
  let done = prewarmedTabs.get(tabId);
  if (!done) {
    done = new Set();
    prewarmedTabs.set(tabId, done);
  }
  for (const url of cfg.prewarm) {
    if (done.has(url)) continue;
    try {
      const [exec] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: inPageFetch,
        args: [{ method: 'GET', url, headers: { accept: 'application/json' }, timeoutMs: 15_000 }],
      });
      done.add(url);
      const status = (exec?.result as InPageFetchResult | undefined)?.status;
      console.log(`[wabe-bridge] prewarm ${url} → ${status ?? '(no result)'}`);
    } catch (err) {
      // Don't poison the cache — leave room for the next request to retry.
      console.warn(`[wabe-bridge] prewarm ${url} failed: ${(err as Error).message}`);
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  prewarmedTabs.delete(tabId);
});

interface BridgeRequestMessage {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  read_state?: { js_path: string };
}

/**
 * Read-state mode: find any tab whose URL host matches `targetHost`, then
 * evaluate `jsPath` in MAIN world. Returns the JSON-stringified value as the
 * response body. Used by sources whose portal won't replicate via raw fetch
 * (e.g. immoscout24 SRP, behind DataDome on SPA-emitted XHRs). The user must
 * keep a real browsing tab open at the portal — there's no fallback.
 */
async function executeReadState(targetHost: string, jsPath: string): Promise<InPageFetchResult> {
  // chrome.tabs.query requires a match pattern; the literal host filter works.
  const tabs = await chrome.tabs.query({ url: `*://${targetHost}/*` });
  const tabId =
    tabs.find((t) => t.id !== undefined && t.status === 'complete')?.id ??
    tabs.find((t) => t.id !== undefined)?.id;
  if (tabId === undefined) {
    return {
      status: 404,
      headers: {},
      body: `no tab open at ${targetHost} — open a real browsing session there to enable scanning`,
    };
  }
  try {
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      // biome-ignore lint/security/noGlobalEval: jsPath comes from a trusted plugin, not network input
      func: (path: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const fn = new Function(`return (${path});`);
          const value = fn();
          return { ok: true as const, value };
        } catch (e) {
          return { ok: false as const, error: (e as Error).message };
        }
      },
      args: [jsPath],
    });
    const result = exec?.result as { ok: true; value: unknown } | { ok: false; error: string } | undefined;
    if (!result) {
      return { status: 500, headers: {}, body: 'executeScript returned no result' };
    }
    if (!result.ok) {
      return { status: 500, headers: {}, body: `read-state error: ${result.error}` };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result.value),
    };
  } catch (err) {
    return { status: 500, headers: {}, body: `read-state threw: ${(err as Error).message}` };
  }
}

// --------- Per-request proxy (used by Chrome onMessage AND Firefox proxyRequest) ---------

async function executeProxyRequest(msg: BridgeRequestMessage): Promise<InPageFetchResult> {
  if (msg.read_state) {
    const host = new URL(msg.url).host;
    return executeReadState(host, msg.read_state.js_path);
  }
  const targetOrigin = new URL(msg.url).origin;
  const tabId = await ensureTabForOrigin(targetOrigin);
  await ensureRequestPrewarm(tabId, targetOrigin);
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
  // Walk the union of bundled defaults + daemon-pushed overrides; an override
  // for a known default replaces it, so the Set dedups on origin key.
  const origins = new Set<string>([
    ...Object.keys(DEFAULT_TAB_HOMEPAGE),
    ...Object.keys(dynamicTabOverrides),
  ]);
  for (const origin of origins) {
    try {
      await ensureTabForOrigin(origin);
    } catch (err) {
      console.warn(`[wabe-bridge] prewarm ${origin} failed: ${(err as Error).message}`);
    }
  }
}

function installChromePath(): void {
  // Restore persisted overrides before the first prewarm so SW reboots don't
  // lose state between daemon connects.
  void loadPersistedTabOverrides().then(() => prewarmTabs());

  chrome.runtime.onInstalled.addListener(() => {
    void ensureOffscreen();
    void prewarmTabs();
  });
  chrome.runtime.onStartup.addListener(() => {
    void ensureOffscreen();
    void prewarmTabs();
  });
  void ensureOffscreen();

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
      // the reconnect. Also clear the single-client block AND any stale
      // peer-attempt banner so the offscreen doc's blocked check passes
      // once it picks up the next welcome.
      void chrome.storage.local.remove(['bridgeBlockedReason', 'bridgePeerAttempt']).catch(() => {
        /* non-fatal */
      });
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
    if (message?.type === 'wabe-bridge:set-tab-overrides') {
      const payload = (message.payload ?? []) as IncomingTabOverride[];
      applyTabOverrides(Array.isArray(payload) ? payload : []);
      // Open warm tabs for any newly-registered origins eagerly so the first
      // request doesn't pay the tab-open + DataDome-challenge latency.
      void prewarmTabs();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'wabe-bridge:set-blocked') {
      const payload = (message.payload ?? {}) as {
        reason?: string;
        detail?: string | null;
        at?: number;
      };
      void chrome.storage.local
        .set({
          bridgeBlockedReason: {
            reason: payload.reason ?? 'another_client_active',
            detail: payload.detail ?? null,
            at: payload.at ?? Date.now(),
          },
        })
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    if (message?.type === 'wabe-bridge:set-peer-attempt') {
      const payload = (message.payload ?? {}) as { at?: string; extension_version?: string };
      void chrome.storage.local
        .set({
          bridgePeerAttempt: {
            at: payload.at ?? new Date().toISOString(),
            extension_version: payload.extension_version ?? 'unknown',
          },
        })
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, message: err.message }));
      return true;
    }
    if (message?.type === 'wabe-bridge:reload-extension') {
      // Offscreen-initiated reload (Chrome). The SW has chrome.runtime.reload
      // even though the offscreen doc doesn't. Mirrors the Firefox path where
      // the BG itself calls reload().
      console.log('[wabe-bridge] reload request from offscreen; reloading');
      chrome.runtime.reload();
      sendResponse({ ok: true });
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
    /**
     * Set when the daemon rejected us with `another_client_active`. Suppresses
     * the auto-reconnect loop until the user explicitly clicks Reconnect in
     * the popup — otherwise two paired browsers would trip a ~1Hz preempt
     * storm.
     */
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

  async function setBridgeBlocked(reason: string, detail?: string): Promise<void> {
    try {
      await chrome.storage.local.set({
        bridgeBlockedReason: { reason, detail: detail ?? null, at: Date.now() },
      });
    } catch {
      /* non-fatal */
    }
  }

  async function clearBridgeBlocked(): Promise<void> {
    state.blocked = false;
    try {
      // Clear the peer-attempt banner alongside the block reason: once the
      // user has reconnected to take over the bridge, the "another instance
      // tried to connect" banner is stale and would otherwise persist.
      await chrome.storage.local.remove(['bridgeBlockedReason', 'bridgePeerAttempt']);
    } catch {
      /* non-fatal */
    }
  }

  async function loadBridgeBlockedFromStorage(): Promise<void> {
    try {
      const v = await chrome.storage.local.get('bridgeBlockedReason');
      if (v.bridgeBlockedReason) state.blocked = true;
    } catch {
      /* non-fatal */
    }
  }

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
    if (state.blocked) return; // user must explicitly Reconnect via popup
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
      if (!state.everPaired) {
        state.everPaired = true;
        console.log('[wabe-bridge] paired with wabe agent');
      }
      // Daemon supplies its current view of the dist/background.js hash;
      // self-reload if it diverges from ours. Lets the dev loop be
      // "rebuild ext → daemon notices change" without manually clicking
      // Reload in about:debugging.
      if (typeof msg.bundle_hash === 'string') {
        console.log('[wabe-bridge] welcome bundle_hash =', msg.bundle_hash.slice(0, 12));
        await maybeSelfReload(msg.bundle_hash);
      }
      if (Array.isArray(msg.tab_overrides)) {
        applyTabOverrides(msg.tab_overrides as IncomingTabOverride[]);
        void prewarmTabs();
      }
      return;
    }
    if (msg.type === 'heartbeat') {
      // Out-of-band ping every ~30s; carries bundle_hash + tab_overrides.
      if (typeof msg.bundle_hash === 'string') {
        await maybeSelfReload(msg.bundle_hash);
      }
      if (Array.isArray(msg.tab_overrides)) {
        applyTabOverrides(msg.tab_overrides as IncomingTabOverride[]);
      }
      return;
    }
    if (msg.type === 'reject') {
      const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown';
      const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
      console.warn('[wabe-bridge] rejected by server:', reason, detail ?? '');
      if (reason === 'another_client_active') {
        await setBridgeBlocked(reason, detail);
        // Stop the reconnect loop until the user explicitly clicks Reconnect.
        if (state.reconnectTimer !== null) {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = null;
        }
        state.reconnectDelayMs = 1_000;
        state.blocked = true;
      }
      ws.close();
      return;
    }
    if (msg.type === 'peer_attempt') {
      // Existing-client notification: another extension tried to claim the
      // bridge. Persist a transient flag so popup can show "another instance
      // tried to connect at <ts>" without changing connection state.
      const at = typeof msg.at === 'string' ? msg.at : new Date().toISOString();
      const peerVersion = typeof msg.extension_version === 'string' ? msg.extension_version : 'unknown';
      void chrome.storage.local
        .set({ bridgePeerAttempt: { at, extension_version: peerVersion } })
        .catch(() => {
          /* non-fatal */
        });
      return;
    }
    if (msg.type === 'keepalive') {
      // Server-side application-level heartbeat. Receiving the message
      // resets Firefox MV3's ~30s background-suspension timer.
      await chrome.storage.local.set({ lastAliveAt: Date.now() });
      return;
    }
    if (msg.type === 'request') {
      await proxyRequest(ws, msg as unknown as BridgeRequestMessage);
    }
  }

  /** Hex SHA-256 of this extension's own background.js, computed lazily and cached. */
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
      console.warn('[wabe-bridge] failed to hash own bundle:', (err as Error).message);
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
      `[wabe-bridge] bundle hash drifted (own=${own.slice(0, 8)} daemon=${daemonHash.slice(0, 8)}); reloading`,
    );
    // Small delay so the heartbeat reply doesn't get cut mid-send.
    setTimeout(() => chrome.runtime.reload(), 250);
  }

  async function connect(): Promise<void> {
    if (state.connecting) return;
    if (state.blocked) return; // wait for explicit popup-driven Reconnect
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
      // Only clear state.ws when this exact socket is still the current one.
      // A second connect() may have already replaced state.ws while we were
      // closing; nulling unconditionally would yank the new connection out
      // from under tickKeepalive.
      if (state.ws === ws) {
        state.ws = null;
      }
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
      // Popup-initiated reconnect always clears the single-client block —
      // user has explicitly opted in to retry.
      void clearBridgeBlocked().then(() => connect());
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
  void loadPersistedTabOverrides().then(() => prewarmTabs());

  /**
   * Pokes the WS with `{type:'ping'}` if open; reconnects if closed.
   * Used by both the alarm tick (suspension wake-up path) and the in-page
   * setInterval (fast heartbeat while alive). A JSON write counts as activity
   * for Firefox's idle suspension timer, so frequent writes keep the page warm.
   */
  function tickKeepalive(): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      let sent = false;
      try {
        state.ws.send(JSON.stringify({ type: 'ping' }));
        sent = true;
      } catch {
        /* close will surface separately */
      }
      // Only mark the bridge alive when the ping actually went out — a failed
      // send means the socket is closing and the next tick will reconnect.
      if (sent) {
        void chrome.storage.local.set({ lastAliveAt: Date.now() });
      }
    } else if (!state.connecting && (state.ws === null || state.ws.readyState === WebSocket.CLOSED)) {
      // Avoid racing a CONNECTING/CLOSING handshake: only reconnect once the
      // previous socket is fully gone. The close handler will null state.ws
      // for CLOSED sockets; CONNECTING sockets are owned by connect()'s
      // state.connecting guard.
      void connect();
    }
  }

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    tickKeepalive();
  });
  // Re-armed each event-page boot. While the page is alive, this fires far
  // more often than the alarm (which Firefox clamps to >=30s); combined with
  // server-side 5s keepalives it keeps the WS fully active.
  setInterval(tickKeepalive, IN_PAGE_PING_MS);

  // Firefox MV3 has no `chrome.offscreen`, and `background.persistent: true`
  // is rejected by the manifest validator (MV3 forbids persistent backgrounds
  // even though Firefox kept `background.scripts` working). The event page
  // suspends after ~30s idle, dropping the WS until the next alarm tick.
  //
  // Defense in depth (no single trick is officially documented as
  // suspension-blocking, so we layer cheap ones):
  //
  //   a) Web Lock held for the lifetime of the page. `navigator.locks.request`
  //      with an unresolved Promise keeps a lock acquired forever. Firefox's
  //      idle bookkeeping treats outstanding locks as in-flight work and
  //      defers suspension while one is held.
  //   b) chrome.storage.session writes alongside the existing storage.local
  //      pings — storage activity counts as work for the same accounting.
  //      Feature-detected: `storage.session` landed in Firefox 115 but guard
  //      anyway so the SW boots cleanly on older targets.
  //   c) The existing 5s in-page setInterval + 15s alarm remain as catch-up
  //      / wake-up paths in case (a) and (b) ever get tightened.
  installFirefoxIdleHold();

  // Restore blocked state from a prior SW lifetime — survives Firefox MV3
  // suspension and ensures the reconnect loop stays muted across wake-ups.
  void loadBridgeBlockedFromStorage().then(() => connect());
}

/**
 * Belt-and-suspenders keepalive for the Firefox MV3 event page.
 *
 * Holds an unresolved Web Lock for the page's lifetime and writes a heartbeat
 * to `chrome.storage.session` every {@link IN_PAGE_PING_MS} milliseconds. Both
 * are no-ops on Chrome (which uses the offscreen path) so this function is
 * only called from `installFirefoxPath`.
 *
 */
function installFirefoxIdleHold(): void {
  // (a) Hold a Web Lock forever. Returns a Promise that never resolves; the
  //     lock is released only when the event page is actually destroyed.
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks && typeof locks.request === 'function') {
      // `mode: 'shared'` lets multiple SW boots coexist without queuing.
      // Swallow rejections so a transient platform error doesn't take the
      // bridge down.
      void locks
        .request('wabe-bridge-keepalive', { mode: 'shared' }, () => new Promise<void>(() => {}))
        .catch((err: Error) => {
          console.warn(`[wabe-bridge] navigator.locks.request failed: ${err.message}`);
        });
    }
  } catch (err) {
    console.warn(`[wabe-bridge] navigator.locks unavailable: ${(err as Error).message}`);
  }

  // (b) Periodic write to chrome.storage.session — extra activity signal,
  //     cheap, and self-cleans when the page is destroyed.
  const sessionApi = (
    chrome.storage as typeof chrome.storage & {
      session?: { set(items: Record<string, unknown>): Promise<void> };
    }
  ).session;
  if (sessionApi && typeof sessionApi.set === 'function') {
    setInterval(() => {
      sessionApi.set({ lastIdleHoldAt: Date.now() }).catch(() => {
        /* non-fatal — storage.session may be unavailable in some contexts */
      });
    }, IN_PAGE_PING_MS);
  }
}
