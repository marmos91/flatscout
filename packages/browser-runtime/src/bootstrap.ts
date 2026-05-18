import type { Browser, BrowserContext, Page } from 'playwright';
import { errors as playwrightErrors } from 'playwright';
import type { Logger } from 'pino';
import { getStealthBrowser, getStealthPersistentContext } from './stealth.js';
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
  /** Optional CSS selector to wait for in addition to the load event. */
  waitFor?: string;
  /**
   * Load event to wait for. `networkidle` is brittle on pages that poll
   * (anti-bot challenges, telemetry). For interactive flows where a human
   * solves a CAPTCHA, prefer `domcontentloaded` so navigation resolves as
   * soon as the DOM is parseable and the `waitForUser` hook takes over.
   * Default: `networkidle`.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Navigation / selector timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
  /** Run Chromium headless. Defaults to `true`. */
  headless?: boolean;
  /**
   * Playwright browser channel. Set to `'chrome'` to launch real Google
   * Chrome instead of bundled Chromium — passes anti-bot stacks that
   * fingerprint the Chromium binary.
   */
  channel?: 'chrome' | 'chrome-beta' | 'msedge' | 'msedge-beta';
  /**
   * Browser engine. `'firefox'` uses Playwright's Firefox over Marionette
   * — different protocol fingerprint than Chromium-class browsers; often
   * passes DataDome where Chromium gets walled.
   */
  engine?: 'chromium' | 'firefox';
  /**
   * Optional directory to persist the Chromium profile (cookies, storage,
   * `Set-Cookie` history). When set, uses `launchPersistentContext` so the
   * profile survives across bootstrap runs — DataDome and similar anti-bot
   * stacks tend to trust returning sessions more than first-time visitors.
   */
  userDataDir?: string;
  /**
   * Optional async hook invoked after navigation settles but before cookies
   * are harvested. Use this for interactive flows where a human must clear
   * a challenge (CAPTCHA, click-to-continue) before the cookie set is
   * trustworthy. Resolve to proceed; reject to abort the bootstrap.
   */
  waitForUser?: () => Promise<void>;
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
  let context: BrowserContext | undefined;
  try {
    if (opts.userDataDir) {
      context = await getStealthPersistentContext(opts.userDataDir, {
        headless: opts.headless ?? true,
        channel: opts.channel,
        engine: opts.engine,
      });
    } else {
      browser = await getStealthBrowser({
        headless: opts.headless ?? true,
        channel: opts.channel,
        engine: opts.engine,
      });
      context = await browser.newContext();
    }
    const page: Page = (await context.pages())[0] ?? (await context.newPage());

    try {
      try {
        await page.goto(opts.target, {
          waitUntil: opts.waitUntil ?? 'networkidle',
          timeout: timeoutMs,
        });
      } catch (cause) {
        if (!opts.waitForUser) {
          if (cause instanceof playwrightErrors.TimeoutError) {
            throw new BootstrapTimeoutError(
              `Timed out after ${timeoutMs}ms loading ${opts.target}`,
              { cause },
            );
          }
          throw new BootstrapError(`Navigation failed for ${opts.target}`, { cause });
        }
        // Interactive mode: the human is in charge — surface the error in logs
        // but keep the page open so they can complete the flow manually.
        log?.warn({ err: (cause as Error).message }, 'navigation reported error; deferring to user');
      }
      if (opts.waitFor && !opts.waitForUser) {
        await page.waitForSelector(opts.waitFor, { timeout: timeoutMs });
      }
      if (opts.waitForUser) {
        await opts.waitForUser();
      }
    } catch (cause) {
      if (cause instanceof BootstrapError) throw cause;
      if (cause instanceof playwrightErrors.TimeoutError) {
        throw new BootstrapTimeoutError(`Timed out after ${timeoutMs}ms loading ${opts.target}`, {
          cause,
        });
      }
      // Anything reaching here is a waitFor/waitForUser failure (goto errors
      // were already classified above). Surface the underlying cause verbatim.
      throw new BootstrapError(
        `Interactive bootstrap aborted: ${(cause as Error)?.message ?? String(cause)}`,
        { cause },
      );
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
    } else if (context) {
      // Persistent-context path: close the context (which closes its browser).
      try {
        await context.close();
      } catch (closeErr) {
        log?.warn({ err: closeErr }, 'failed to close persistent context');
      }
    }
  }
}
