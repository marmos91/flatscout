import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeMotis, type MotisDeps } from '../src/route-motis.js';
import { pino } from 'pino';

const FIXTURE_1X = JSON.parse(readFileSync(join(__dirname, 'fixtures/motis-itinerary.json'), 'utf8'));
const FIXTURE_2X = JSON.parse(readFileSync(join(__dirname, 'fixtures/motis-2x-itineraries.json'), 'utf8'));
const logger = pino({ level: 'silent' });

let originalDispatcher: Dispatcher;
let mock: MockAgent;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(() => {
  setGlobalDispatcher(originalDispatcher);
});

function deps(): MotisDeps {
  return {
    motisUrl: 'http://motis.local',
    timeoutMs: 15000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('routeMotis (1.x response shape)', () => {
  it('picks the fastest connection from content.connections', async () => {
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, FIXTURE_1X);
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.4, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toEqual({ durationS: 1740, distanceM: 0 });
  });

  it('returns null when no connections', async () => {
    mock
      .get('http://motis.local')
      .intercept({ path: '/api/v1/plan', method: 'POST' })
      .reply(200, { content_type: 'RoutingResponse', content: { connections: [] } });
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.4, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toBeNull();
  });

  it('returns null on 5xx', async () => {
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(503, 'down');
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.4, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toBeNull();
  });
});

describe('routeMotis (2.x response shape)', () => {
  it('picks the fastest itinerary from itineraries[]', async () => {
    mock.get('http://motis.local').intercept({ path: '/api/v1/plan', method: 'POST' }).reply(200, FIXTURE_2X);
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.4, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toEqual({ durationS: 1740, distanceM: 0 });
  });

  it('returns null when itineraries[] is empty', async () => {
    mock
      .get('http://motis.local')
      .intercept({ path: '/api/v1/plan', method: 'POST' })
      .reply(200, { itineraries: [] });
    const out = await routeMotis(
      { from: [47.37, 8.54], to: [47.4, 8.55] },
      new Date('2026-05-18T08:30:00Z'),
      deps(),
    );
    expect(out).toBeNull();
  });
});
