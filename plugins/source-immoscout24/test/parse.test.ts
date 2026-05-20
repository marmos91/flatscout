import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInitialState, IS24SrpListingSchema } from '../src/parse.js';

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
