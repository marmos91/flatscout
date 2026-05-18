#!/usr/bin/env node
/**
 * Web-XHR probe for homegate.ch. Launches a stealth Chromium against
 * www.homegate.ch's rent search, records every XHR/fetch issued, and
 * dumps a concise summary to stdout (plus a JSON file under
 * docs/research/captures/).
 *
 * Run: node scripts/probe-homegate-web.mjs
 *
 * Requires Chromium installed via `pnpm install:browsers`.
 */

import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = `${__dirname}/../../../docs/research/captures`;
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_FILE = `${OUT_DIR}/homegate-web-xhr-${TS}.json`;

// Target a Zurich rent search with filters comparable to the iOS capture.
// homegate.ch URL pattern: /rent/<property-type>/<region>/<filters>/matching-list
const SEARCH_URL =
  'https://www.homegate.ch/rent/real-estate/canton-zurich/matching-list?ac=8001,8002,8003,8004,8005,8006,8008,8032&be=3&ag=4500';

const HOST_FILTER = /homegate\.ch|graphql|api/;

async function main() {
  chromiumExtra.use(StealthPlugin());
  // Headed mode + slow ramp gives DataDome's behavioural heuristics signals
  // closer to a real user. Persistent profile remembered across runs would
  // help further; this probe uses ephemeral but real-headed.
  const headed = process.env.HEADED === '1';
  const browser = await chromiumExtra.launch({ headless: !headed });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    /** @type {Array<{ts: number, kind: 'req'|'res', method?: string, url: string, status?: number, type?: string, postData?: string, requestHeaders?: Record<string, string>, responseHeaders?: Record<string, string>, contentType?: string, bodySnippet?: string}>} */
    const events = [];

    page.on('request', (req) => {
      const url = req.url();
      if (!HOST_FILTER.test(url)) return;
      const t = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(t)) return;
      events.push({
        ts: Date.now(),
        kind: 'req',
        method: req.method(),
        url,
        type: t,
        postData: req.postData() ?? undefined,
        requestHeaders: req.headers(),
      });
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (!HOST_FILTER.test(url)) return;
      const req = res.request();
      const t = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(t)) return;
      const headers = res.headers();
      const ct = headers['content-type'] ?? '';
      let snippet;
      try {
        if (ct.includes('json') || ct.includes('text')) {
          const text = await res.text();
          snippet = text.slice(0, 400);
        } else {
          snippet = `<${ct || 'unknown'}>`;
        }
      } catch {
        snippet = '<read failed>';
      }
      events.push({
        ts: Date.now(),
        kind: 'res',
        url,
        status: res.status(),
        type: t,
        responseHeaders: headers,
        contentType: ct,
        bodySnippet: snippet,
      });
    });

    // Pre-warm: visit the /rent landing page first so Cloudflare/DataDome
    // issue clearance cookies.
    console.error('pre-warming via /rent landing');
    await page.goto('https://www.homegate.ch/rent', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(3000);

    // Direct probe: invoke fetch() from inside the browser context to see if
    // Chromium's own TLS stack can reach api.homegate.ch with the cookies
    // it already holds. This tells us whether the path forward is to drive
    // search via page.evaluate() rather than replaying cookies with undici.
    console.error('probing api.homegate.ch from inside browser context');
    const apiProbe = await page.evaluate(async () => {
      const body = {
        sortBy: 'dateCreated',
        sortDirection: 'desc',
        trackTotalHits: true,
        from: 0,
        size: 5,
        fieldset: 'srp-list',
        query: {
          offerType: 'RENT',
          propertyType: 'APARTMENT_OR_HOUSE',
          location: { geoTags: ['geo-zipcode-8001', 'geo-zipcode-8002'] },
          monthlyRent: { to: 4500 },
          numberOfRooms: { from: 3 },
        },
      };
      try {
        const res = await fetch('https://api.homegate.ch/search/listings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, bodySnippet: text.slice(0, 400), bodyLen: text.length };
      } catch (err) {
        return { error: String(err) };
      }
    });
    console.error('api.homegate.ch probe result:', JSON.stringify(apiProbe, null, 2));

    console.error(`navigating to ${SEARCH_URL}`);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(3000);

    // Scroll to trigger lazy-loading / pagination XHRs.
    console.error('scrolling to trigger XHR pagination');
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1500);
    }

    // Also try clicking pagination button if present.
    const pageButtons = await page.$$('a[href*="ep="], button[data-test*="next"], a[aria-label*="next" i]');
    if (pageButtons.length > 0) {
      console.error(`found ${pageButtons.length} pagination element(s) — clicking first`);
      try {
        await pageButtons[0].click();
        await page.waitForTimeout(3000);
      } catch (err) {
        console.error('click failed:', err.message);
      }
    }

    // Dump a snippet of the document HTML to confirm SSR shape.
    const docTitle = await page.title();
    const docHtmlLen = (await page.content()).length;
    console.error(`page title: "${docTitle}", html length: ${docHtmlLen}`);

    // Look for window.__INITIAL_STATE__ or similar JSON blob in HTML.
    const initialState = await page.evaluate(() => {
      // Common SPA hydration globals.
      const w = /** @type {Record<string, unknown>} */ (globalThis);
      const keys = Object.keys(w).filter((k) => /initial|hydrat|preload|__data|__state/i.test(k));
      const out = {};
      for (const k of keys) {
        try {
          const v = w[k];
          out[k] = typeof v === 'object' ? '<object>' : String(v).slice(0, 100);
        } catch {
          out[k] = '<inaccessible>';
        }
      }
      return out;
    });
    console.error('hydration globals:', JSON.stringify(initialState, null, 2));

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(OUT_FILE, JSON.stringify(events, null, 2));

    // Print a compact summary to stdout.
    const xhrs = events.filter((e) => e.kind === 'req' && (e.type === 'xhr' || e.type === 'fetch'));
    const hostCounts = new Map();
    for (const e of xhrs) {
      const host = new URL(e.url).host;
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    }
    console.log('\n=== XHR/fetch host counts ===');
    for (const [host, n] of [...hostCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(3)}  ${host}`);
    }

    console.log('\n=== JSON-returning endpoints (first 20) ===');
    const jsonRes = events.filter((e) => e.kind === 'res' && e.contentType && e.contentType.includes('json'));
    for (const e of jsonRes.slice(0, 20)) {
      const u = new URL(e.url);
      console.log(
        `  ${e.status}  ${u.host}${u.pathname}${u.search ? `?${u.search.slice(0, 60)}${u.search.length > 60 ? '…' : ''}` : ''}`,
      );
    }

    console.log('\n=== POST endpoints (potential search APIs) ===');
    const posts = events.filter((e) => e.kind === 'req' && e.method === 'POST');
    for (const e of posts) {
      const u = new URL(e.url);
      console.log(`  POST  ${u.host}${u.pathname}`);
      if (e.postData) {
        const snip = e.postData.slice(0, 200);
        console.log(`    body: ${snip}${e.postData.length > 200 ? '…' : ''}`);
      }
    }

    console.log(`\nFull capture: ${OUT_FILE}`);
    console.log(`${events.length} events total (${xhrs.length} XHR/fetch reqs)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
