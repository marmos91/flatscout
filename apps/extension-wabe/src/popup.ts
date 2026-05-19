export {};

/**
 * Popup UI — paste the pairing URL + token from `wabe bridge pair`, click Save,
 * the service worker reconnects with the new credentials.
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8431/bridge';
const STALE_AFTER_MS = 90_000;
const HEX64 = /^[0-9a-f]{64}$/;

const statusEl = document.getElementById('status') as HTMLDivElement;
const bridgeUrlEl = document.getElementById('bridgeUrl') as HTMLInputElement;
const tokenEl = document.getElementById('authToken') as HTMLTextAreaElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const forgetBtn = document.getElementById('forget') as HTMLButtonElement;

interface StoredState {
  bridgeUrl?: string;
  authToken?: string;
  lastConnectedAt?: number;
  lastRequestAt?: number;
  lastAliveAt?: number;
}

function setStatus(cls: 'connected' | 'disconnected' | 'unpaired', text: string): void {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text;
}

function fmtAge(ts: number | undefined): string {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

async function loadState(): Promise<StoredState> {
  return (await chrome.storage.local.get([
    'bridgeUrl',
    'authToken',
    'lastConnectedAt',
    'lastRequestAt',
    'lastAliveAt',
  ])) as StoredState;
}

/** Initial render — populates input fields once on popup open. */
async function initInputs(): Promise<void> {
  const s = await loadState();
  bridgeUrlEl.value = s.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  tokenEl.value = s.authToken ?? '';
}

/** Status-only refresh — runs every second; does NOT touch input fields. */
async function renderStatus(): Promise<void> {
  const s = await loadState();
  if (!s.authToken) {
    setStatus('unpaired', 'not paired — paste URL + token below.');
    return;
  }
  const lastSeen = Math.max(s.lastConnectedAt ?? 0, s.lastRequestAt ?? 0, s.lastAliveAt ?? 0);
  const stale = lastSeen === 0 || Date.now() - lastSeen > STALE_AFTER_MS;
  if (stale) {
    setStatus('disconnected', `disconnected (last seen ${fmtAge(lastSeen || undefined)}).`);
  } else {
    setStatus('connected', `connected (last activity ${fmtAge(lastSeen)}).`);
  }
}

saveBtn.addEventListener('click', async () => {
  const bridgeUrl = bridgeUrlEl.value.trim();
  const authToken = tokenEl.value.trim().toLowerCase();
  if (!bridgeUrl.startsWith('ws://') && !bridgeUrl.startsWith('wss://')) {
    setStatus('disconnected', 'bridge URL must start with ws:// or wss://');
    return;
  }
  if (!HEX64.test(authToken)) {
    setStatus('disconnected', 'token must be 64 hex characters (from `wabe bridge pair`).');
    return;
  }
  await chrome.storage.local.set({ bridgeUrl, authToken });
  await chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' });
  setStatus('disconnected', 'saved — reconnecting…');
  setTimeout(() => {
    void renderStatus();
  }, 1_500);
});

forgetBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['authToken', 'lastConnectedAt', 'lastRequestAt', 'lastAliveAt']);
  await chrome.runtime.sendMessage({ type: 'wabe-bridge:reconnect' });
  tokenEl.value = '';
  await renderStatus();
});

void initInputs().then(() => renderStatus());
// Refresh only the status text every second so age/freshness stay current.
// Inputs are populated once at open — never overwritten while the user types.
setInterval(() => void renderStatus(), 1_000);
