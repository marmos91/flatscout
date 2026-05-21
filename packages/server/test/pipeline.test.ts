import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDb, migrate, type FlatscoutDb } from '@flatscout/db';
import type { RawListing } from '@flatscout/core';
import type { Notifier, Source } from '@flatscout/plugin-sdk';
import { CircuitBreaker } from '../src/circuit.js';
import { Quota } from '../src/quota.js';
import { disposeSources, runOnce } from '../src/pipeline.js';
import { createLogger } from '../src/logger.js';

let dir: string;
let db: FlatscoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-pipe-'));
  db = openDb(join(dir, 'pipe.db'));
  migrate(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeStubSource(name: string, items: RawListing[], opts: { throws?: boolean } = {}): Source {
  return {
    name,
    configSchema: z.object({}).default({}),
    async *fetch() {
      if (opts.throws) throw new Error(`boom in ${name}`);
      for (const r of items) yield r;
    },
  };
}

function makeStubNotifier(): {
  notifier: Notifier;
  sent: Array<{ id: string; url: string; score: number }>;
} {
  const sent: Array<{ id: string; url: string; score: number }> = [];
  const notifier: Notifier = {
    name: 'stub',
    configSchema: z.object({}).default({}),
    async notify(event) {
      sent.push({ id: event.listing.id, url: event.listing.url, score: event.score.final });
      return { ok: true };
    },
  };
  return { notifier, sent };
}

const baseRaw = (id: string, price: number, rooms: number): RawListing => ({
  id: `stub:${id}`,
  source: 'stub',
  url: `https://x.example/${id}`,
  price: { rent_net: null, extras: null, total: price, currency: 'CHF', deposit_months: null },
  rooms,
  area_m2: 80,
  floor: null,
  total_floors: null,
  built_year: null,
  renovated_year: null,
  location: {
    coords: null,
    address: null,
    postal_code: null,
    city: 'Zürich',
    region: null,
    country: 'CH',
    neighborhood: null,
  },
  description: null,
  photos: [],
  available_from: null,
  agency: null,
});

describe('runOnce pipeline', () => {
  it('routes 2 above-threshold listings to the notifier', async () => {
    const items: RawListing[] = [baseRaw('a', 2200, 4), baseRaw('b', 3000, 3.5), baseRaw('c', 2100, 4.5)];
    const src = makeStubSource('src-a', items);
    const { notifier, sent } = makeStubNotifier();
    await runOnce({
      cfg: {
        configDir: dir,
        rentalTerm: { mode: 'long', exclude_unknown: false },
        top: {
          enabled: { sources: [], scorers: [], notifiers: [], enrichers: [], applicators: [] },
          log: { level: 'silent' },
        },
        filters: { filters: [{ kind: 'field', field: 'rooms', op: '>=', value: 3.5, on_missing: 'fail' }] },
        scoring: {
          scoring: [
            {
              type: 'rule',
              name: 'price',
              weight: 100,
              metric: 'price.total',
              on_missing: 'zero',
              normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
            },
          ],
          notify: { threshold: 60, daily_quota: 10 },
        },
      },
      db,
      logger: createLogger('silent'),
      signal: new AbortController().signal,
      sources: [{ name: 'src-a', kind: 'source', plugin: src, config: {} }],
      enrichers: [],
      notifiers: [{ name: 'stub', kind: 'notifier', plugin: notifier, config: {} }],
      breakers: new Map([['src-a', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })]]),
      quota: new Quota(db, 10),
    });
    // price 2200 → linear(2200, best=2000, worst=4000, invert) = (4000-2200)/(4000-2000)=0.9 → 90
    // price 3000 → 0.5 → 50 (below threshold 60)
    // price 2100 → 0.95 → 95
    // NOTE: listing.id is now canonical_key after the row-collapse spec, so assert
    // against the source-provided url which uniquely identifies the raw input.
    expect(sent.map((s) => s.url).sort()).toEqual(['https://x.example/a', 'https://x.example/c']);
  });

  it('isolates source failure; other sources still run', async () => {
    const goodItems = [baseRaw('z', 2100, 4)];
    const good = makeStubSource('good', goodItems);
    const bad = makeStubSource('bad', [], { throws: true });
    const { notifier, sent } = makeStubNotifier();
    const breakers = new Map([
      ['good', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })],
      ['bad', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })],
    ]);
    await runOnce({
      cfg: {
        configDir: dir,
        rentalTerm: { mode: 'long', exclude_unknown: false },
        top: {
          enabled: { sources: [], scorers: [], notifiers: [], enrichers: [], applicators: [] },
          log: { level: 'silent' },
        },
        filters: { filters: [] },
        scoring: {
          scoring: [
            {
              type: 'rule',
              name: 'p',
              weight: 1,
              metric: 'price.total',
              on_missing: 'zero',
              normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
            },
          ],
          notify: { threshold: 0, daily_quota: 10 },
        },
      },
      db,
      logger: createLogger('silent'),
      signal: new AbortController().signal,
      sources: [
        { name: 'good', kind: 'source', plugin: good, config: {} },
        { name: 'bad', kind: 'source', plugin: bad, config: {} },
      ],
      enrichers: [],
      notifiers: [{ name: 'stub', kind: 'notifier', plugin: notifier, config: {} }],
      breakers,
      quota: new Quota(db, 10),
    });
    // NOTE: listing.id is now canonical_key after the row-collapse spec.
    expect(sent.map((s) => s.url)).toEqual(['https://x.example/z']);
    const failures = db._raw.prepare('SELECT plugin FROM failures').all() as Array<{ plugin: string }>;
    expect(failures.map((f) => f.plugin)).toContain('bad');
  });

  it('calls plugin.dispose() once on shutdown', async () => {
    const dispose = vi.fn(async () => {});
    const stub: Source = {
      name: 'stub-dispose',
      configSchema: z.object({}).default({}),
      async *fetch() {
        /* yields nothing */
      },
      dispose,
    };
    await disposeSources(
      [{ name: 'stub-dispose', kind: 'source', plugin: stub, config: {} }],
      createLogger('silent'),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing dispose; sibling plugins still disposed', async () => {
    const goodDispose = vi.fn(async () => {});
    const badDispose = vi.fn(async () => {
      throw new Error('dispose boom');
    });
    const good: Source = {
      name: 'good',
      configSchema: z.object({}).default({}),
      async *fetch() {},
      dispose: goodDispose,
    };
    const bad: Source = {
      name: 'bad',
      configSchema: z.object({}).default({}),
      async *fetch() {},
      dispose: badDispose,
    };
    await disposeSources(
      [
        { name: 'good', kind: 'source', plugin: good, config: {} },
        { name: 'bad', kind: 'source', plugin: bad, config: {} },
      ],
      createLogger('silent'),
    );
    expect(goodDispose).toHaveBeenCalledTimes(1);
    expect(badDispose).toHaveBeenCalledTimes(1);
  });

  it('trips circuit breaker after N failures', async () => {
    const bad = makeStubSource('bad', [], { throws: true });
    const { notifier } = makeStubNotifier();
    const breaker = new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 });
    const breakers = new Map([['bad', breaker]]);
    const baseRun = () =>
      runOnce({
        cfg: {
          configDir: dir,
          rentalTerm: { mode: 'long', exclude_unknown: false },
          top: {
            enabled: { sources: [], scorers: [], notifiers: [], enrichers: [], applicators: [] },
            log: { level: 'silent' },
          },
          filters: { filters: [] },
          scoring: {
            scoring: [
              {
                type: 'rule',
                name: 'p',
                weight: 1,
                metric: 'price.total',
                on_missing: 'zero',
                normalize: { type: 'linear', best: 1, worst: 2, invert: false },
              },
            ],
            notify: { threshold: 0, daily_quota: 10 },
          },
        },
        db,
        logger: createLogger('silent'),
        signal: new AbortController().signal,
        sources: [{ name: 'bad', kind: 'source', plugin: bad, config: {} }],
        enrichers: [],
        notifiers: [{ name: 'stub', kind: 'notifier', plugin: notifier, config: {} }],
        breakers,
        quota: new Quota(db, 10),
      });
    await baseRun();
    await baseRun();
    await baseRun();
    expect(breaker.state()).toBe('open');
    await baseRun(); // breaker open, source skipped → no new failure
    const fails = db._raw.prepare('SELECT COUNT(*) AS c FROM failures').get() as { c: number };
    expect(fails.c).toBe(3);
  });
});
