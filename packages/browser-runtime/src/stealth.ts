import type { Browser } from 'playwright';
import { chromium } from 'playwright-extra';
// puppeteer-extra-plugin-stealth is a CJS module that exports a factory
// function as the default export.
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

export interface GetStealthBrowserOptions {
  headless?: boolean;
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
  const headless = opts.headless ?? true;
  chromium.use(StealthPlugin());
  return chromium.launch({ headless }) as Promise<Browser>;
}
