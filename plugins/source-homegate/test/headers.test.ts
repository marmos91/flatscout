import { describe, expect, it } from 'vitest';
import { buildHeaders, newXAppId } from '../src/headers.js';

describe('newXAppId', () => {
  it('generates 1000 unique decimal nonces of <=26 digits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = newXAppId();
      expect(id).toMatch(/^\d{1,26}$/);
      // Leading zeros must not be re-emitted by the function.
      if (id.length > 1) expect(id[0]).not.toBe('0');
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('buildHeaders', () => {
  const CHROME_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36';
  const baseInput = {
    cookie: 'datadome=abc; __cf_bm=def',
    userAgent: CHROME_UA,
  };

  it('returns browser-shaped headers without bearer', () => {
    const h = buildHeaders(baseInput);
    expect(h.Accept).toBe('application/json, text/plain, */*');
    expect(h['Accept-Encoding']).toBeUndefined();
    expect(h['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(h['User-Agent']).toBe(CHROME_UA);
    expect(h.Origin).toBe('https://www.homegate.ch');
    expect(h.Referer).toBe('https://www.homegate.ch/');
    expect(h.Cookie).toBe(baseInput.cookie);
    expect(h.Authorization).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
  });

  it('omits the iOS-app-specific headers (X-UDID, X-App-Version, X-App-Id, Priority)', () => {
    const h = buildHeaders(baseInput);
    expect(h['X-UDID']).toBeUndefined();
    expect(h['X-App-Version']).toBeUndefined();
    expect(h['X-App-Id']).toBeUndefined();
    expect(h.Priority).toBeUndefined();
  });

  it('adds Content-Type when hasBody is true', () => {
    const h = buildHeaders({ ...baseInput, hasBody: true });
    expect(h['Content-Type']).toBe('application/json');
  });

  it('adds Authorization when bearer is present', () => {
    const h = buildHeaders({ ...baseInput, bearer: 'jwt.abc.def' });
    expect(h.Authorization).toBe('Bearer jwt.abc.def');
  });
});
