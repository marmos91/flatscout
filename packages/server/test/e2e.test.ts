import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { migrate, openDb, type WabeDb } from '@wabe/db';
import { CircuitBreaker, Quota, createLogger, loadConfig, loadPlugins, runOnce } from '../src/index.js';

let dir: string;
let db: WabeDb;
let agent: MockAgent;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-e2e-'));
  db = openDb(join(dir, 'e2e.db'));
  migrate(db);
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(): void {
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  writeFileSync(
    join(dir, 'config.yaml'),
    `enabled:
  sources:
    - {name: ff, plugin: source-flatfox, config: plugins/ff.yaml}
  notifiers:
    - {name: tg, plugin: notifier-telegram, config: plugins/tg.yaml}
log: {level: silent}
`,
  );
  writeFileSync(join(dir, 'filters.yaml'), 'filters: []\n');
  writeFileSync(
    join(dir, 'scoring.yaml'),
    `scoring:
  - {type: rule, name: p, weight: 1, metric: price.total, on_missing: zero, normalize: {type: linear, best: 2000, worst: 5000, invert: true}}
notify:
  threshold: 0
  daily_quota: 100
`,
  );
  writeFileSync(
    join(dir, 'plugins', 'ff.yaml'),
    `schedule: '*/5 * * * *'
search: {offer_type: RENT, category: FLAT}
fetch: {page_size: 5, max_pages: 1, pace_ms: 0, backoff: {on: [429], retries: 0, base_ms: 1}}
`,
  );
  writeFileSync(
    join(dir, 'plugins', 'tg.yaml'),
    `bot_token: 'TEST_TOKEN'
chat_id: 123
format: compact
`,
  );
}

describe('E2E pipeline with real plugins', () => {
  it('flatfox API → filter → score → telegram', async () => {
    writeConfig();

    agent
      .get('https://flatfox.ch')
      .intercept({ method: 'GET', path: /public-listing/ })
      .reply(200, {
        results: [
          {
            pk: 100,
            slug: 'a',
            city: 'Zürich',
            price_display: 2500,
            number_of_rooms: '3.5',
            surface_living: 80,
            offer_type: 'RENT',
            object_category: 'FLAT',
            latitude: 47.37,
            longitude: 8.54,
            agency: { name: 'AA' },
          },
          {
            pk: 101,
            slug: 'b',
            city: 'Bern',
            price_display: 1800,
            number_of_rooms: '2.0',
            surface_living: 50,
            offer_type: 'RENT',
            object_category: 'FLAT',
            latitude: 46.94,
            longitude: 7.44,
            agency: { name: 'BB' },
          },
        ],
        next: null,
      });
    agent
      .get('https://api.telegram.org')
      .intercept({ method: 'POST', path: /\/botTEST_TOKEN\/sendMessage/ })
      .reply(200, { ok: true, result: { message_id: 7 } })
      .persist();

    const cfg = await loadConfig(dir);
    const loaded = await loadPlugins(cfg);
    const breakers = new Map(
      loaded.sources.map((s) => [s.name, new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })]),
    );
    const quota = new Quota(db, cfg.scoring.notify.daily_quota);

    await runOnce({
      cfg,
      db,
      logger: createLogger('silent'),
      signal: new AbortController().signal,
      sources: loaded.sources,
      enrichers: loaded.enrichers,
      notifiers: loaded.notifiers,
      breakers,
      quota,
    });

    const listings = db._raw.prepare('SELECT id FROM listings ORDER BY id').all() as Array<{
      id: string;
    }>;
    expect(listings.map((l) => l.id).sort()).toEqual(['flatfox:100', 'flatfox:101']);
    const scores = db._raw.prepare('SELECT listing_id, final FROM scores').all() as Array<{
      listing_id: string;
      final: number;
    }>;
    expect(scores.length).toBe(2);
    const notifs = db._raw.prepare('SELECT listing_id FROM notifications').all() as Array<{
      listing_id: string;
    }>;
    expect(notifs.length).toBe(2);
  });
});
