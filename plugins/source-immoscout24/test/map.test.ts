import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInitialState } from '../src/parse.js';
import { mapSrpListing } from '../src/map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures', 'srp-zurich-page1.html'), 'utf8');
const state = extractInitialState(html)!;
const cards = state.resultList.search.fullSearch.result.listings;

describe('mapSrpListing', () => {
  it('returns null when listing.id is missing', () => {
    expect(mapSrpListing({ ...cards[0]!, id: '' as unknown as string }, 'en')).toBeNull();
  });

  it('produces a RawListing with canonical fields populated from the SRP card', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(r.source).toBe('source-immoscout24');
    expect(r.id).toMatch(/^immoscout24:\d+$/);
    expect(r.url).toMatch(/^https:\/\/www\.immoscout24\.ch\/rent\/\d+$/);
    expect(typeof r.price.total === 'number' || r.price.total === null).toBe(true);
    expect(typeof r.rooms === 'number' || r.rooms === null).toBe(true);
    expect(typeof r.area_m2 === 'number' || r.area_m2 === null).toBe(true);
    expect(r.location.country).toBe('CH');
  });

  it('reads localization in the configured language with fallback', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(typeof r.description === 'string' || r.description === null).toBe(true);
    if (r.description) expect(r.description.length).toBeGreaterThan(0);
  });

  it('extracts photo URLs from localization.<lang>.attachments where type=IMAGE', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(Array.isArray(r.photos)).toBe(true);
    for (const u of r.photos) expect(u).toMatch(/^https:\/\/cdn\.immoscout24\.ch\//);
  });

  it('records cross-platform flags under enriched.cross_listed_on', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(Array.isArray((r.enriched as Record<string, unknown>).cross_listed_on)).toBe(true);
  });

  it('leaves agency=null and contact={} when SRP carries no contact info', () => {
    const r = mapSrpListing(cards[0]!, 'de')!;
    expect(r.agency).toBeNull();
    expect(r.contact).toEqual({});
  });

  it('reads geo coordinates in GeoJSON [lng, lat] order', () => {
    const card = cards.find((c) => c.listing.address?.geoCoordinates?.latitude != null)!;
    const r = mapSrpListing(card, 'de')!;
    expect(Array.isArray(r.location.coords)).toBe(true);
    expect(r.location.coords).toHaveLength(2);
    const [lng, lat] = r.location.coords!;
    expect(lat).toBeGreaterThan(45);
    expect(lat).toBeLessThan(48);
    expect(lng).toBeGreaterThan(5);
    expect(lng).toBeLessThan(11);
  });
});
