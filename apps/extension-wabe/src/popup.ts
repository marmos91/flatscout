export {};

/**
 * Popup UI — diagnostics-aware view over the bridge state stored in
 * chrome.storage.local. Reactive: subscribes to chrome.storage.onChanged
 * for value updates, and keeps a slow 5s fallback timer to refresh
 * relative-age strings ("2s ago" → "7s ago").
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const STALE_AFTER_MS = 30_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HOST_MAX = 22;
const RELATIVE_REFRESH_MS = 5_000;
const RECONNECT_FEEDBACK_MS = 1_500;

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

interface StoredState {
  bridgeUrl?: string;
  authToken?: string;
  lastConnectedAt?: number;
  lastRequestAt?: number;
  lastAliveAt?: number;
  bridgeStats?: BridgeStats;
}

const dotEl = document.getElementById('dot') as HTMLSpanElement;
const statusTextEl = document.getElementById('statusText') as HTMLSpanElement;
const errorPanelEl = document.getElementById('errorPanel') as HTMLDivElement;
const infoPanelEl = document.getElementById('infoPanel') as HTMLDivElement;
const requestsTodayEl = document.getElementById('requestsToday') as HTMLSpanElement;
const errorsTodayEl = document.getElementById('errorsToday') as HTMLSpanElement;
const lastErrorEl = document.getElementById('lastError') as HTMLSpanElement;
const recentEl = document.getElementById('recent') as HTMLUListElement;
const recentEmptyEl = document.getElementById('recentEmpty') as HTMLParagraphElement;
const bridgeUrlEl = document.getElementById('bridgeUrl') as HTMLInputElement;
const tokenEl = document.getElementById('authToken') as HTMLTextAreaElement;
const pasteBtn = document.getElementById('paste') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const testBtn = document.getElementById('test') as HTMLButtonElement;
const forgetBtn = document.getElementById('forget') as HTMLButtonElement;

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function fmtAge(ts: number | undefined): string {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function fmtShortAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function truncHost(host: string): string {
  return host.length <= HOST_MAX ? host : `${host.slice(0, HOST_MAX - 1)}…`;
}

function statusColor(status: number): 'green' | 'yellow' | 'red' {
  if (status >= 200 && status < 300) return 'green';
  if (status >= 300 && status < 500) return 'yellow';
  return 'red';
}

async function loadState(): Promise<StoredState> {
  return (await chrome.storage.local.get([
    'bridgeUrl',
    'authToken',
    'lastConnectedAt',
    'lastRequestAt',
    'lastAliveAt',
    'bridgeStats',
  ])) as StoredState;
}

/** Populate input fields once on popup open — never overwritten mid-edit. */
async function initInputs(): Promise<void> {
  const s = await loadState();
  bridgeUrlEl.value = s.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  tokenEl.value = s.authToken ?? '';
}

function renderStatus(s: StoredState): void {
  if (!s.authToken) {
    dotEl.className = 'dot yellow';
    statusTextEl.textContent = 'Not paired · paste credentials below';
    return;
  }
  const lastSeen = Math.max(s.lastConnectedAt ?? 0, s.lastRequestAt ?? 0, s.lastAliveAt ?? 0);
  const stale = lastSeen === 0 || Date.now() - lastSeen > STALE_AFTER_MS;
  if (stale) {
    dotEl.className = 'dot red';
    statusTextEl.textContent = `Disconnected · last seen ${lastSeen ? fmtAge(lastSeen) : 'never'}`;
  } else {
    dotEl.className = 'dot green';
    statusTextEl.textContent = `Connected · alive ${fmtAge(lastSeen)}`;
  }
}

function renderStats(s: StoredState): void {
  const today = todayString();
  const stats =
    s.bridgeStats && s.bridgeStats.statsDay === today
      ? s.bridgeStats
      : { statsDay: today, requestsToday: 0, errorsToday: 0, recentRequests: [] as RecentRequestEntry[] };

  requestsTodayEl.textContent = `${stats.requestsToday}`;
  const errCount = stats.errorsToday;
  errorsTodayEl.textContent = `${errCount} error${errCount === 1 ? '' : 's'}`;
  errorsTodayEl.className = `err-count${errCount > 0 ? ' has-err' : ''}`;

  // Last error: only show if it's from today (errorsToday already gates the
  // counter on day rollover; gate the relative-time line too).
  const errToday =
    stats.statsDay === today && stats.lastErrorAt && stats.errorsToday > 0
      ? { at: stats.lastErrorAt, msg: stats.lastErrorMessage ?? 'error' }
      : null;
  if (errToday) {
    const truncated = errToday.msg.length > 60 ? `${errToday.msg.slice(0, 60)}…` : errToday.msg;
    lastErrorEl.innerHTML = '';
    const ageNode = document.createTextNode(`${fmtAge(errToday.at)} — `);
    const msgSpan = document.createElement('span');
    msgSpan.className = 'msg';
    msgSpan.textContent = truncated;
    lastErrorEl.appendChild(ageNode);
    lastErrorEl.appendChild(msgSpan);
  } else {
    lastErrorEl.textContent = '(none)';
  }
}

function renderRecent(s: StoredState): void {
  const today = todayString();
  const entries = s.bridgeStats && s.bridgeStats.statsDay === today ? s.bridgeStats.recentRequests : [];
  recentEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    recentEmptyEl.hidden = false;
    return;
  }
  recentEmptyEl.hidden = true;
  for (const e of entries) {
    const li = document.createElement('li');

    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = fmtShortAge(e.at);

    const method = document.createElement('span');
    method.className = 'method';
    method.textContent = e.method;

    const host = document.createElement('span');
    host.className = 'host';
    host.title = e.host;
    host.textContent = truncHost(e.host);

    const status = document.createElement('span');
    const displayStatus = e.status === 0 ? 'ERR' : `${e.status}`;
    status.className = `status ${statusColor(e.status)}`;
    status.textContent = displayStatus;

    const ms = document.createElement('span');
    ms.className = 'ms';
    ms.textContent = `${e.ms}ms`;

    li.appendChild(age);
    li.appendChild(method);
    li.appendChild(host);
    li.appendChild(status);
    li.appendChild(ms);
    recentEl.appendChild(li);
  }
}

async function render(): Promise<void> {
  const s = await loadState();
  renderStatus(s);
  renderStats(s);
  renderRecent(s);
}

function showError(text: string): void {
  errorPanelEl.textContent = text;
  errorPanelEl.hidden = false;
  infoPanelEl.hidden = true;
}

function clearError(): void {
  errorPanelEl.hidden = true;
  errorPanelEl.textContent = '';
}

function showInfo(text: string, autoHideMs?: number): void {
  infoPanelEl.textContent = text;
  infoPanelEl.hidden = false;
  if (autoHideMs !== undefined) {
    setTimeout(() => {
      if (infoPanelEl.textContent === text) {
        infoPanelEl.hidden = true;
      }
    }, autoHideMs);
  }
}

pasteBtn.addEventListener('click', async () => {
  clearError();
  try {
    const text = (await navigator.clipboard.readText()).trim().toLowerCase();
    tokenEl.value = text;
    if (!HEX64.test(text)) {
      showError('Clipboard content is not a 64-hex token.');
    }
  } catch (err) {
    showError(`Paste failed: ${(err as Error).message}`);
  }
});

saveBtn.addEventListener('click', async () => {
  clearError();
  const bridgeUrl = bridgeUrlEl.value.trim();
  const authToken = tokenEl.value.trim().toLowerCase();
  if (!bridgeUrl.startsWith('ws://') && !bridgeUrl.startsWith('wss://')) {
    showError('Bridge URL must start with ws:// or wss://');
    return;
  }
  if (!HEX64.test(authToken)) {
    showError('Token must be 64 hex characters (from `wabe bridge pair`).');
    return;
  }
  await chrome.storage.local.set({ bridgeUrl, authToken });
  await chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' });
  showInfo('Saved — reconnecting…', RECONNECT_FEEDBACK_MS);
  setTimeout(() => void render(), RECONNECT_FEEDBACK_MS);
});

testBtn.addEventListener('click', async () => {
  clearError();
  showInfo('Reconnecting…', RECONNECT_FEEDBACK_MS);
  try {
    await chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' });
  } catch (err) {
    showError(`Reconnect failed: ${(err as Error).message}`);
    return;
  }
  setTimeout(() => void render(), RECONNECT_FEEDBACK_MS);
});

forgetBtn.addEventListener('click', async () => {
  clearError();
  await chrome.storage.local.remove([
    'authToken',
    'lastConnectedAt',
    'lastRequestAt',
    'lastAliveAt',
    'bridgeStats',
  ]);
  await chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' });
  tokenEl.value = '';
  await render();
});

// Reactive: re-render on every storage change. We don't filter by key
// because every key we render off is in `local`, and the cost is trivial.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  void render();
});

// Slow fallback to refresh relative-age strings ("2s ago" → "7s ago").
setInterval(() => void render(), RELATIVE_REFRESH_MS);

void initInputs().then(() => render());
