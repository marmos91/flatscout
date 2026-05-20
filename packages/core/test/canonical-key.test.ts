import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  roundRoomsBucket,
  roundAreaBucket,
  roundPriceBucket,
  SOURCE_PRIORITY_DEFAULTS,
} from '../src/canonical-key.js';

describe('bucket helpers', () => {
  it('rounds rooms to nearest 0.5', () => {
    expect(roundRoomsBucket(3.7)).toBe(3.5);
    expect(roundRoomsBucket(3.8)).toBe(4.0);
    expect(roundRoomsBucket(null)).toBeNull();
  });
  it('rounds area to nearest 5 m²', () => {
    expect(roundAreaBucket(112)).toBe(110);
    expect(roundAreaBucket(113)).toBe(115);
    expect(roundAreaBucket(null)).toBeNull();
  });
  it('rounds price to nearest 50 CHF', () => {
    // NOTE: deviated from plan — plan asserted 3274 → 3300 but 3274 / 50 = 65.48 rounds to 65, giving 3250.
    // Implementation uses Math.round(price / 50) * 50 verbatim from plan; using 3280 here yields 3300.
    expect(roundPriceBucket(3280)).toBe(3300);
    expect(roundPriceBucket(3225)).toBe(3250);
    expect(roundPriceBucket(null)).toBeNull();
  });
});

describe('canonicalKey', () => {
  it('returns a deterministic sha256 for fully-populated input', () => {
    const a = canonicalKey({
      postal_code: '8008',
      rooms: 4.5,
      area_m2: 112,
      price_total: 3200,
      url: 'https://x/1',
    });
    const b = canonicalKey({
      postal_code: '8008',
      rooms: 4.5,
      area_m2: 112,
      price_total: 3200,
      url: 'https://x/2',
    });
    expect(a).toBe(b); // same bucket inputs ⇒ same key regardless of URL
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('collides on near-equal listings within bucket tolerance', () => {
    // NOTE: deviated from plan — plan used area_m2 113 which buckets to 115, while 110 buckets to 110.
    // Adjusted b's area to 112 (buckets to 110) so the two inputs actually collide given the documented bucket sizes.
    const a = canonicalKey({
      postal_code: '8008',
      rooms: 4.4,
      area_m2: 110,
      price_total: 3225,
      url: 'https://x/1',
    });
    const b = canonicalKey({
      postal_code: '8008',
      rooms: 4.5,
      area_m2: 112,
      price_total: 3260,
      url: 'https://x/2',
    });
    expect(a).toBe(b);
  });
  it('falls back to URL-based key when any bucket field is missing', () => {
    const a = canonicalKey({
      postal_code: '8008',
      rooms: null,
      area_m2: 112,
      price_total: 3200,
      url: 'https://x/1',
    });
    const b = canonicalKey({
      postal_code: '8008',
      rooms: null,
      area_m2: 112,
      price_total: 3200,
      url: 'https://x/2',
    });
    expect(a).not.toBe(b);
  });
});

describe('SOURCE_PRIORITY_DEFAULTS', () => {
  it('orders agency-direct > portals > aggregators > tertiary', () => {
    expect(SOURCE_PRIORITY_DEFAULTS.agency).toBe(100);
    expect(SOURCE_PRIORITY_DEFAULTS['source-flatfox']).toBe(80);
    expect(SOURCE_PRIORITY_DEFAULTS['source-homegate']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-immoscout24']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-immobilier-ch']).toBe(70);
    expect(SOURCE_PRIORITY_DEFAULTS['source-realadvisor']).toBe(50);
  });
  it('source-schemaorg lands in portal tier (70)', () => {
    expect(SOURCE_PRIORITY_DEFAULTS['source-schemaorg']).toBe(70);
  });
});
