import { describe, expect, it } from 'vitest';
import { buildHeaders, newXAppId, USER_AGENT, X_APP_VERSION } from '../src/headers.js';

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
  const baseInput = {
    cookie: 'datadome=abc; __cf_bm=def',
    xUdid: '0E9A3DF1-F4D9-4AA5-9457-7246692CDE4D',
  };

  it('returns the captured header set without bearer', () => {
    const h = buildHeaders(baseInput);
    expect(h.Accept).toBe('*/*');
    expect(h['Accept-Encoding']).toBe('gzip, deflate, br');
    expect(h['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(h['User-Agent']).toBe(USER_AGENT);
    expect(h['X-App-Version']).toBe(X_APP_VERSION);
    expect(h['X-UDID']).toBe(baseInput.xUdid);
    expect(h['X-App-Id']).toMatch(/^\d{1,26}$/);
    expect(h.Priority).toBe('u=3');
    expect(h.Cookie).toBe(baseInput.cookie);
    expect(h.Authorization).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
  });

  it('adds Content-Type when hasBody is true', () => {
    const h = buildHeaders({ ...baseInput, hasBody: true });
    expect(h['Content-Type']).toBe('application/json');
  });

  it('adds Authorization when bearer is present', () => {
    const h = buildHeaders({ ...baseInput, bearer: 'jwt.abc.def' });
    expect(h.Authorization).toBe('Bearer jwt.abc.def');
  });

  it('regenerates X-App-Id per call', () => {
    const a = buildHeaders(baseInput);
    const b = buildHeaders(baseInput);
    expect(a['X-App-Id']).not.toBe(b['X-App-Id']);
  });
});
