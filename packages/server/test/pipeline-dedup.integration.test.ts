import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb, migrate, type FlatscoutDb } from '@flatscout/db';
import type { RawListing } from '@flatscout/core';
import type { ListingEvent, Notifier, Source } from '@flatscout/plugin-sdk';
import { CircuitBreaker } from '../src/circuit.js';
import { Quota } from '../src/quota.js';
import { runOnce } from '../src/pipeline.js';
import { createLogger } from '../src/logger.js';

/**
 * Cross-source dedup integration test (canonical-row model).
 *
 * Three stub sources whose names match `SOURCE_PRIORITY_DEFAULTS` keys
 * (source-flatfox=80, source-immobilier-ch=70, source-realadvisor=50) emit
 * RawListings that all bucket to the same canonical_key. After `runOnce`:
 *  - Exactly ONE notification fires, on the FIRST source's INSERT (flatfox,
 *    running first by ordering). `also_seen_on` is `[]` at notification time
 *    because no other source has arrived yet — this matches the new
 *    notify-on-first-INSERT contract; the spec defers "edit message footer
 *    on second arrival" to a future spec.
 *  - The merged DB row ends up authoritative=source-flatfox (priority-wins),
 *    seen_on_sources lists all three contributors, and there is exactly one
 *    row at the canonical_key.
 */

let dir: string;
let db: FlatscoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-dedup-'));
  db = openDb(join(dir, 'pipe.db'));
  migrate(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeStub(name: string, items: RawListing[]): Source {
  return {
    name,
    configSchema: z.object({}).default({}),
    async *fetch() {
      for (const r of items) yield r;
    },
  };
}

function makeCapture(): { notifier: Notifier; events: ListingEvent[] } {
  const events: ListingEvent[] = [];
  const notifier: Notifier = {
    name: 'capture',
    configSchema: z.object({}).default({}),
    async notify(event) {
      events.push(event);
      return { ok: true };
    },
  };
  return { notifier, events };
}

function raw(source: string, id: string, url: string): RawListing {
  return {
    id: `${source}:${id}`,
    source,
    url,
    price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
    rooms: 4.5,
    area_m2: 112,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: '8008',
      city: 'Zürich',
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description: null,
    photos: [],
    available_from: null,
    agency: null,
  };
}

describe('cross-source dedup — end-to-end pipeline', () => {
  it('three sources publishing the same canonical listing produce exactly one notification', async () => {
    const flatfox = makeStub('source-flatfox', [raw('source-flatfox', '1', 'https://flatfox.ch/1')]);
    const immobilier = makeStub('source-immobilier-ch', [
      raw('source-immobilier-ch', '1', 'https://immobilier.ch/1'),
    ]);
    const realadvisor = makeStub('source-realadvisor', [
      raw('source-realadvisor', '1', 'https://realadvisor.ch/1'),
    ]);
    const { notifier, events } = makeCapture();

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
      // Order matters: flatfox first so it wins the priority tie-breaker on
      // first_seen_at and survives shouldNotify; the other two arrive after
      // and get suppressed.
      sources: [
        { name: 'flatfox', kind: 'source', plugin: flatfox, config: {} },
        { name: 'immobilier', kind: 'source', plugin: immobilier, config: {} },
        { name: 'realadvisor', kind: 'source', plugin: realadvisor, config: {} },
      ],
      enrichers: [],
      notifiers: [{ name: 'capture', kind: 'notifier', plugin: notifier, config: {} }],
      breakers: new Map([
        ['flatfox', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })],
        ['immobilier', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })],
        ['realadvisor', new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 10_000 })],
      ]),
      quota: new Quota(db, 10),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.listing.source).toBe('source-flatfox');
    expect(events[0]?.also_seen_on).toEqual([]);

    const rows = db._raw.prepare('SELECT id, source, seen_on_sources FROM listings').all() as Array<{
      id: string;
      source: string;
      seen_on_sources: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('source-flatfox');
    expect(JSON.parse(rows[0]?.seen_on_sources ?? '[]').sort()).toEqual([
      'source-flatfox',
      'source-immobilier-ch',
      'source-realadvisor',
    ]);
  });
});
