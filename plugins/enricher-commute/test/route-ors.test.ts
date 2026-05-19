import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOrs, type OrsDeps } from '../src/route-ors.js';
import { pino } from 'pino';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures/ors-cycling.json'), 'utf8'));
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

function deps(): OrsDeps {
  return {
    orsUrl: 'http://ors.local',
    timeoutMs: 15000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('routeOrs', () => {
  it('returns duration_s + distance_m for cycling profile', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, FIXTURE);
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.4, 8.55] }, 'cycling', deps());
    expect(out).toEqual({ durationS: Math.round(1320.7), distanceM: Math.round(6234.5) });
  });

  it('maps modes → profiles correctly', async () => {
    for (const [mode, profile] of [
      ['driving', 'driving-car'],
      ['cycling', 'cycling-regular'],
      ['walking', 'foot-walking'],
    ] as const) {
      mock
        .get('http://ors.local')
        .intercept({ path: `/v2/directions/${profile}`, method: 'POST' })
        .reply(200, FIXTURE);
      const out = await routeOrs({ from: [47.37, 8.54], to: [47.4, 8.55] }, mode, deps());
      expect(out).not.toBeNull();
    }
  });

  it('returns null on 5xx', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(503, 'down');
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.4, 8.55] }, 'cycling', deps());
    expect(out).toBeNull();
  });

  it('returns null when no routes in response', async () => {
    mock
      .get('http://ors.local')
      .intercept({ path: '/v2/directions/cycling-regular', method: 'POST' })
      .reply(200, { routes: [] });
    const out = await routeOrs({ from: [47.37, 8.54], to: [47.4, 8.55] }, 'cycling', deps());
    expect(out).toBeNull();
  });
});
