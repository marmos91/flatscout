import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geocode, type GeocodeDeps } from '../src/geocode.js';
import { pino } from 'pino';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures/pelias-zurich.json'), 'utf8'));
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

function deps(): GeocodeDeps {
  return {
    peliasUrl: 'http://pelias.local',
    timeoutMs: 5000,
    logger,
    signal: new AbortController().signal,
  };
}

describe('geocode', () => {
  it('returns first feature on hit', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*text=.*/, method: 'GET' })
      .reply(200, FIXTURE);
    const out = await geocode('Brandschenkestrasse 178, 8002 Zürich', deps());
    expect(out).toEqual({ lat: 47.3677, lng: 8.5345 });
  });

  it('returns null on empty feature collection', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*/, method: 'GET' })
      .reply(200, { type: 'FeatureCollection', features: [] });
    const out = await geocode('nowhere', deps());
    expect(out).toBeNull();
  });

  it('returns null on 5xx', async () => {
    mock
      .get('http://pelias.local')
      .intercept({ path: /\/v1\/search\?.*/, method: 'GET' })
      .reply(503, 'down');
    const out = await geocode('Foo', deps());
    expect(out).toBeNull();
  });
});
