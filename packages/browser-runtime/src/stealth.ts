import type { Browser, BrowserContext } from 'playwright';
import { firefox } from 'playwright';
import { chromium } from 'playwright-extra';
// puppeteer-extra-plugin-stealth is a CJS module that exports a factory
// function as the default export.
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

export interface GetStealthBrowserOptions {
  headless?: boolean;
  /**
   * Playwright browser channel. `'chrome'` launches the user's installed
   * Google Chrome stable instead of Playwright's bundled Chromium — anti-bot
   * stacks (DataDome, Cloudflare BM) tend to flag the Chromium binary's
   * fingerprint regardless of stealth patches. Default: bundled Chromium.
   */
  channel?: 'chrome' | 'chrome-beta' | 'msedge' | 'msedge-beta';
  /**
   * Browser engine. `'firefox'` uses Playwright's Firefox over Marionette
   * (not CDP) — different protocol fingerprint, often passes DataDome
   * where Chromium-class browsers get walled. Stealth plugin is not
   * applied to Firefox (it's Chromium-specific).
   */
  engine?: 'chromium' | 'firefox';
}

/**
 * Chromium args that suppress the most obvious automation tells (above and
 * beyond what the stealth plugin already patches at the JS level). Real
 * browsers don't run with `--enable-automation` and don't advertise the
 * `AutomationControlled` blink feature.
 */
const REALISTIC_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
];

const REALISTIC_VIEWPORT = { width: 1280, height: 800 } as const;
const REALISTIC_LOCALE = 'en-US';

let stealthApplied = false;
function ensureStealth(): void {
  if (stealthApplied) return;
  chromium.use(StealthPlugin());
  stealthApplied = true;
}

/**
 * Returns a Playwright `Browser` launched with the stealth plugin applied.
 *
 * Caller is responsible for calling `browser.close()`.
 *
 * Note: Chromium is downloaded lazily by Playwright on the first `launch()`
 * call. This avoids slowing every workspace install (and breaking CI). The
 * ~300MB download happens only when a consumer actually runs the bootstrap
 * flow.
 */
export async function getStealthBrowser(opts: GetStealthBrowserOptions = {}): Promise<Browser> {
  if (opts.engine === 'firefox') {
    return firefox.launch({ headless: opts.headless ?? true });
  }
  ensureStealth();
  return chromium.launch({
    headless: opts.headless ?? true,
    args: REALISTIC_ARGS,
    channel: opts.channel,
  }) as Promise<Browser>;
}

/**
 * Returns a Playwright `BrowserContext` launched with a persistent user-data
 * directory. Profile state (cookies, storage, history) survives across
 * launches, which materially improves trust with anti-bot stacks that score
 * returning visitors higher than first-time ones.
 *
 * Caller is responsible for calling `context.close()`.
 */
export async function getStealthPersistentContext(
  userDataDir: string,
  opts: GetStealthBrowserOptions = {},
): Promise<BrowserContext> {
  if (opts.engine === 'firefox') {
    return firefox.launchPersistentContext(userDataDir, {
      headless: opts.headless ?? true,
      viewport: REALISTIC_VIEWPORT,
      locale: REALISTIC_LOCALE,
    });
  }
  ensureStealth();
  return chromium.launchPersistentContext(userDataDir, {
    headless: opts.headless ?? true,
    args: REALISTIC_ARGS,
    viewport: REALISTIC_VIEWPORT,
    locale: REALISTIC_LOCALE,
    channel: opts.channel,
  }) as Promise<BrowserContext>;
}
