import type { Browser, Page } from 'playwright';
import { errors as playwrightErrors } from 'playwright';
import type { Logger } from 'pino';
import { getStealthBrowser } from './stealth.js';
import { BootstrapError, BootstrapTimeoutError } from './errors.js';

export interface BootstrapCookie {
  name: string;
  value: string;
  domain: string;
  /** Epoch seconds, or `null` for session cookies. */
  expires: number | null;
}

export interface BootstrapResult {
  /** Ready-to-attach `Cookie:` header value: `name=value; name=value; ...`. */
  cookieHeader: string;
  cookies: BootstrapCookie[];
  /** Epoch milliseconds when the cookies were harvested. */
  capturedAt: number;
  /** The Chromium User-Agent string used during the bootstrap. */
  userAgent: string;
}

export interface BootstrapOptions {
  /** Absolute URL of the page to load. */
  target: string;
  /** Optional CSS selector to wait for in addition to `networkidle`. */
  waitFor?: string;
  /** Navigation / selector timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
  /** Run Chromium headless. Defaults to `true`. */
  headless?: boolean;
  /** Optional pino logger. */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Domain-matching: a cookie applies to the request host if its `domain`
 * attribute equals the host (`host.tld`) or is a dot-prefixed parent
 * (`.host.tld` covering subdomains of `host.tld`).
 */
export function cookieDomainMatches(cookieDomain: string, host: string): boolean {
  const normalized = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  if (host === normalized) return true;
  return host.endsWith(`.${normalized}`);
}

/** Format an array of cookies into a single `Cookie:` header value. */
export function formatCookieHeader(cookies: { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Launch a stealth Chromium, navigate to `target`, wait for the page to
 * settle, and return all cookies whose domain applies to the target host
 * along with a ready-to-attach `Cookie:` header.
 *
 * The browser is always closed before this function returns, including on
 * error paths.
 */
export async function bootstrapSite(opts: BootstrapOptions): Promise<BootstrapResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.logger?.child({ component: 'browser-runtime/bootstrap' });

  let host: string;
  try {
    host = new URL(opts.target).host;
  } catch (cause) {
    throw new BootstrapError(`Invalid target URL: ${opts.target}`, { cause });
  }

  log?.debug({ target: opts.target, host, timeoutMs }, 'launching stealth browser');

  let browser: Browser | undefined;
  try {
    browser = await getStealthBrowser({ headless: opts.headless ?? true });
    const context = await browser.newContext();
    const page: Page = await context.newPage();

    try {
      await page.goto(opts.target, { waitUntil: 'networkidle', timeout: timeoutMs });
      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { timeout: timeoutMs });
      }
    } catch (cause) {
      if (cause instanceof playwrightErrors.TimeoutError) {
        throw new BootstrapTimeoutError(`Timed out after ${timeoutMs}ms loading ${opts.target}`, {
          cause,
        });
      }
      throw new BootstrapError(`Navigation failed for ${opts.target}`, { cause });
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);

    const all = await context.cookies();
    const matching = all.filter((c) => cookieDomainMatches(c.domain, host));

    const cookies: BootstrapCookie[] = matching.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      // Playwright reports `-1` for session cookies; normalise to `null`.
      expires: c.expires === -1 ? null : c.expires,
    }));

    const cookieHeader = formatCookieHeader(cookies);

    log?.debug({ cookieCount: cookies.length }, 'harvested cookies');

    return {
      cookieHeader,
      cookies,
      capturedAt: Date.now(),
      userAgent,
    };
  } catch (err) {
    if (err instanceof BootstrapError) throw err;
    throw new BootstrapError(`Bootstrap failed for ${opts.target}`, { cause: err });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        log?.warn({ err: closeErr }, 'failed to close browser');
      }
    }
  }
}
