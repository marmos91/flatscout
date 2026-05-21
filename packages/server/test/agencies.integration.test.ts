import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import { loadPlugins } from '../src/loader.js';

let dir: string;
let agent: MockAgent;
let prev: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-agencies-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  prev = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(prev);
  rmSync(dir, { recursive: true, force: true });
});

const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://walde.example/objekt-12345</loc><lastmod>2026-05-18</lastmod></url>
</urlset>`;

const DETAIL = `<html><head>
<script type="application/ld+json">{"@type":"RealEstateListing","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich"},"image":"https://walde.example/i.jpg"}</script>
</head></html>`;

function writeYaml(path: string, body: string) {
  writeFileSync(join(dir, path), body, 'utf8');
}

describe('agency registry — end-to-end', () => {
  it('expands one schemaorg row into a working source plugin that yields a listing', async () => {
    writeYaml(
      'config.yaml',
      `enabled:
  sources:
    - {name: agencies-test, plugin: agencies, config: plugins/agencies.yaml}
  notifiers: []
log: { level: silent }
`,
    );
    writeYaml(
      'filters.yaml',
      `filters: []
`,
    );
    writeYaml(
      'scoring.yaml',
      `scoring:
  - {type: rule, name: x, weight: 1, metric: price.total, normalize: {type: linear, best: 1, worst: 2, invert: false}}
notify: { threshold: 0, daily_quota: 10 }
`,
    );
    writeYaml(
      'plugins/agencies.yaml',
      `registry: ./agencies.yaml
`,
    );
    writeYaml(
      'agencies.yaml',
      `version: 1
source: test
agencies:
  - id: walde
    name: Walde
    website: https://walde.example
    canton: ZH
    platform: schemaorg
    enabled: true
`,
    );
    // Intercept the schemaorg plugin's sitemap + detail HTTPs.
    const pool = agent.get('https://walde.example');
    pool
      .intercept({ method: 'GET', path: '/sitemap.xml' })
      .reply(200, SITEMAP, { headers: { 'content-type': 'application/xml' } });
    pool
      .intercept({ method: 'GET', path: '/objekt-12345' })
      .reply(200, DETAIL, { headers: { 'content-type': 'text/html' } });

    const cfg = await loadConfig(dir);
    expect(cfg.top.enabled.sources.some((s) => s.name === 'agency:schemaorg:walde')).toBe(true);
    expect(cfg.skippedAgencies).toEqual([]);

    const plugins = await loadPlugins(cfg);
    const src = plugins.sources.find((s) => s.name === 'agency:schemaorg:walde');
    expect(src).toBeTruthy();
    if (!src) return;

    // NOTE: deviated from plan — abort after the first yielded listing so the
    // plugin's default 5s pace_ms doesn't push the test past the default vitest
    // timeout. Both `pace_ms` and `max_details_per_scan` are non-overridable from
    // the registry row, so signal-based termination is the cleanest gate.
    const ac = new AbortController();
    const yielded = [];
    for await (const raw of src.plugin.fetch({
      logger: {
        child: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
      } as never,
      config: src.config,
      signal: ac.signal,
      db: { _raw: {} as never } as never,
    })) {
      yielded.push(raw);
      ac.abort();
    }
    expect(yielded).toHaveLength(1);
    expect(yielded[0]?.id).toBe('agency:walde:12345');
    expect(yielded[0]?.rooms).toBe(3.5);
  });
});
