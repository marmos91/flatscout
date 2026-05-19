import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { enrichCommute } from '../src/enrich.js';
import type { CommuteConfig } from '../src/schemas.js';

const logger = pino({ level: 'silent' });
const ORS = JSON.parse(readFileSync(join(__dirname, 'fixtures/ors-cycling.json'), 'utf8'));
const MOTIS = JSON.parse(readFileSync(join(__dirname, 'fixtures/motis-itinerary.json'), 'utf8'));

function freshDb() {
  const db = new Database(':memory:');
  for (const f of ['0001_init.sql', '0002_dedup_fields.sql', '0003_commute_cache.sql']) {
    db.exec(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

let originalDispatcher: Dispatcher;
let mock: MockAgent;
beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(() => setGlobalDispatcher(originalDispatcher));

const cfg: CommuteConfig = {
  endpoints: {
    ors_url: 'http://ors.local',
    motis_url: 'http://motis.local',
    pelias_url: 'http://pelias.local',
  },
  targets: {
    work: {
      coords: [8.5395, 47.3681],
      arrive_by: '08:30',
      weekday: 'mon',
      modes: ['transit', 'cycling'],
    },
  },
  cache: { enabled: true, quantize_decimals: 4 },
  timeouts: { geocode_ms: 5000, route_ms: 15000 },
};

const listingWithCoords = {
  id: 'a',
  source: 's',
  url: 'https://x/a',
  first_seen_at: new Date(),
  last_seen_at: new Date(),
  price: { rent_net: null, total: null, extras: null, currency: 'CHF', deposit_months: null },
  rooms: null,
  area_m2: null,
  floor: null,
  total_floors: null,
  built_year: null,
  renovated_year: null,
  location: {
    coords: [8.54, 47.37] as [number, number],
    address: null,
    postal_code: null,
    city: null,
    region: null,
    country: 'CH',
    neighborhood: null,
  },
  features: {},
  description: null,
  photos: [],
  available_from: null,
  lease_until: null,
  rental_term: 'unknown' as const,
  agency: null,
  contact: {},
  enriched: {},
  extra: {},
  canonical_key: '',
  source_priority: 50,
  seen_on_sources: [],
};

describe('enrichCommute', () => {
  it('populates enriched.commute for both modes', async () => {
    const db = freshDb();
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, ORS);
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    const out = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    expect(out.enriched.commute).toBeDefined();
    const work = (out.enriched.commute as Record<string, Record<string, { duration_min: number }>>).work;
    expect(work.cycling.duration_min).toBe(22); // 1320.7s → round(1321/60) = 22min
    expect(work.transit.duration_min).toBe(29); // 1740s → 29min
  });

  it('omits failed mode but keeps the rest', async () => {
    const db = freshDb();
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(503, 'down');
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    const out = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    const work = (out.enriched.commute as Record<string, Record<string, unknown>>).work;
    expect(work.cycling).toBeUndefined();
    expect(work.transit).toBeDefined();
  });

  it('returns listing unchanged when listing has no coords and pelias fails', async () => {
    const db = freshDb();
    const noCoords = {
      ...listingWithCoords,
      location: { ...listingWithCoords.location, coords: null, address: 'X' },
    };
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*/, method: 'GET' })
      .reply(503, 'down');
    const out = await enrichCommute(noCoords, cfg, db, logger, new AbortController().signal);
    expect(out.enriched.commute).toBeUndefined();
  });

  it('hits cache on second call (no HTTP traffic)', async () => {
    const db = freshDb();
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, ORS);
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, MOTIS);
    await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    // Second call — no new MockAgent interceptors registered → would throw on HTTP attempt.
    const out2 = await enrichCommute(listingWithCoords, cfg, db, logger, new AbortController().signal);
    const work = (out2.enriched.commute as Record<string, Record<string, { duration_min: number }>>).work;
    expect(work.cycling.duration_min).toBe(22);
    expect(work.transit.duration_min).toBe(29);
  });
});
