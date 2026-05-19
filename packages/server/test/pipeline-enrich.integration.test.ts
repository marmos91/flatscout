import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { openDb, migrate, type WabeDb } from '@wabe/db';
import { runOnce } from '../src/pipeline.js';
import type { LoadedPlugin } from '../src/loader.js';
import type { Source, Enricher, Notifier } from '@wabe/plugin-sdk';
import { Quota } from '../src/quota.js';

let dir: string;
let db: WabeDb;

function freshDb(): WabeDb {
  dir = mkdtempSync(join(tmpdir(), 'wabe-enrich-'));
  db = openDb(join(dir, 'enrich.db'));
  migrate(db);
  return db;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const stubSource: Source = {
  name: 'stub',
  configSchema: { parse: (x: unknown) => x } as never,
  async *fetch() {
    yield {
      id: 'stub:1',
      source: 'stub',
      url: 'https://example.com/1',
      price: { rent_net: 2000, total: 2200, extras: 200, currency: 'CHF', deposit_months: 2 },
      rooms: 3,
      area_m2: 70,
      floor: null,
      total_floors: null,
      built_year: null,
      renovated_year: null,
      location: {
        coords: [8.54, 47.37],
        address: null,
        postal_code: '8002',
        city: 'Zürich',
        region: null,
        country: 'CH',
        neighborhood: null,
      },
      description: null,
      photos: [],
      available_from: null,
      agency: null,
      enriched: {},
    } as never;
  },
};

const stubEnricher: Enricher = {
  name: 'stub-enricher',
  configSchema: { parse: (x: unknown) => x } as never,
  async enrich(listing) {
    return { ...listing, enriched: { ...listing.enriched, marker: 'hit' } };
  },
};

const noopNotifier: Notifier = {
  name: 'noop',
  configSchema: { parse: (x: unknown) => x } as never,
  async notify() {
    return { ok: true };
  },
};

const cfg = {
  configDir: '/tmp',
  filters: { filters: [] },
  scoring: {
    scoring: [
      {
        type: 'rule',
        name: 'p',
        weight: 1,
        metric: 'price.total',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 2000, worst: 5000, invert: true },
      },
    ],
    notify: { threshold: 0, daily_quota: 100 },
  },
  rentalTerm: { mode: 'long' as const, exclude_unknown: false },
  top: {
    enabled: { sources: [], scorers: [], notifiers: [], enrichers: [], applicators: [] },
    log: { level: 'silent' },
    bridge: { enabled: false, port: 8431 },
  },
} as never;

describe('pipeline enricher stage', () => {
  it('runs loaded enrichers and persists the post-enrich payload', async () => {
    const testDb = freshDb();
    const sources: LoadedPlugin<'source'>[] = [
      { name: 'stub', plugin: stubSource, config: {}, kind: 'source' } as never,
    ];
    const enrichers: LoadedPlugin<'enricher'>[] = [
      { name: 'stub-enricher', plugin: stubEnricher, config: {}, kind: 'enricher' } as never,
    ];
    const notifiers: LoadedPlugin<'notifier'>[] = [
      { name: 'noop', plugin: noopNotifier, config: {}, kind: 'notifier' } as never,
    ];

    await runOnce({
      cfg,
      db: testDb,
      logger: pino({ level: 'silent' }),
      signal: new AbortController().signal,
      sources,
      enrichers,
      notifiers,
      breakers: new Map(),
      quota: new Quota(testDb, 100),
    });

    const row = testDb._raw
      .prepare('SELECT payload FROM listings WHERE id = ?')
      .get('stub:1') as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.enriched.marker).toBe('hit');
  });

  it('continues when one enricher throws', async () => {
    const throwingEnricher: Enricher = {
      name: 'throwing',
      configSchema: { parse: (x: unknown) => x } as never,
      async enrich() {
        throw new Error('boom');
      },
    };
    const testDb = freshDb();
    const sources: LoadedPlugin<'source'>[] = [
      { name: 'stub', plugin: stubSource, config: {}, kind: 'source' } as never,
    ];
    const enrichers: LoadedPlugin<'enricher'>[] = [
      { name: 'throwing', plugin: throwingEnricher, config: {}, kind: 'enricher' } as never,
      { name: 'stub-enricher', plugin: stubEnricher, config: {}, kind: 'enricher' } as never,
    ];
    const notifiers: LoadedPlugin<'notifier'>[] = [
      { name: 'noop', plugin: noopNotifier, config: {}, kind: 'notifier' } as never,
    ];

    await runOnce({
      cfg,
      db: testDb,
      logger: pino({ level: 'silent' }),
      signal: new AbortController().signal,
      sources,
      enrichers,
      notifiers,
      breakers: new Map(),
      quota: new Quota(testDb, 100),
    });

    const row = testDb._raw
      .prepare('SELECT payload FROM listings WHERE id = ?')
      .get('stub:1') as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.enriched.marker).toBe('hit');
  });

  it('skips enrichment but still persists listing when no enrichers configured', async () => {
    const testDb = freshDb();
    const sources: LoadedPlugin<'source'>[] = [
      { name: 'stub', plugin: stubSource, config: {}, kind: 'source' } as never,
    ];
    const notifiers: LoadedPlugin<'notifier'>[] = [
      { name: 'noop', plugin: noopNotifier, config: {}, kind: 'notifier' } as never,
    ];

    await runOnce({
      cfg,
      db: testDb,
      logger: pino({ level: 'silent' }),
      signal: new AbortController().signal,
      sources,
      enrichers: [],
      notifiers,
      breakers: new Map(),
      quota: new Quota(testDb, 100),
    });

    const row = testDb._raw
      .prepare('SELECT payload FROM listings WHERE id = ?')
      .get('stub:1') as { payload: string } | undefined;
    expect(row).toBeDefined();
  });
});
