import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInitialState, IS24SrpListingSchema, parseApiResult } from '../src/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures', 'srp-zurich-page1.html'), 'utf8');

describe('extractInitialState', () => {
  it('returns null when the marker is missing', () => {
    expect(extractInitialState('<html><body>no state here</body></html>')).toBeNull();
  });

  it('returns null when the embedded JSON is malformed', () => {
    expect(extractInitialState('<script>window.__INITIAL_STATE__ = {not json};</script>')).toBeNull();
  });

  it('extracts pagination metadata + a typed listings array from a real SRP page', () => {
    const state = extractInitialState(html);
    expect(state).not.toBeNull();
    const result = state!.resultList.search.fullSearch.result;
    expect(result.listings).toHaveLength(20);
    expect(result.page).toBe(1);
    expect(result.itemsPerPage).toBe(20);
    expect(typeof result.hasNextPage).toBe('boolean');
    expect(typeof result.resultCount).toBe('number');
  });

  it('each listing matches IS24SrpListingSchema', () => {
    const state = extractInitialState(html)!;
    for (const card of state.resultList.search.fullSearch.result.listings) {
      const parsed = IS24SrpListingSchema.safeParse(card);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    }
  });
});

describe('parseApiResult', () => {
  // Reuse a card from the SRP fixture so the schema is exercised against
  // a real-shape listing rather than a synthetic stub.
  const cardSample = extractInitialState(html)!.resultList.search.fullSearch.result.listings[0]!;
  const baseShape = {
    listings: [cardSample],
    page: 1,
    pageCount: 5,
    resultCount: 100,
    itemsPerPage: 20,
    hasNextPage: true,
    hasPreviousPage: false,
  };

  it('parses the flat API shape', () => {
    const result = parseApiResult(JSON.stringify(baseShape));
    expect(result).not.toBeNull();
    expect(result!.listings).toHaveLength(1);
    expect(result!.hasNextPage).toBe(true);
  });

  it('unwraps a `result:` envelope', () => {
    const result = parseApiResult(JSON.stringify({ result: baseShape }));
    expect(result).not.toBeNull();
    expect(result!.page).toBe(1);
  });

  it('unwraps a `data:` envelope', () => {
    const result = parseApiResult(JSON.stringify({ data: baseShape }));
    expect(result).not.toBeNull();
    expect(result!.resultCount).toBe(100);
  });

  it('returns null on non-JSON body', () => {
    expect(parseApiResult('<html>nope</html>')).toBeNull();
  });

  it('returns null when shape is missing required fields', () => {
    expect(parseApiResult(JSON.stringify({ listings: [] }))).toBeNull();
  });
});
