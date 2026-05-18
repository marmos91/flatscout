import { describe, expect, it } from 'vitest';
import {
  BootstrapError,
  BootstrapTimeoutError,
  bootstrapSite,
  cookieDomainMatches,
  formatCookieHeader,
} from '../src/index.js';

describe('error classes', () => {
  it('BootstrapTimeoutError is a BootstrapError', () => {
    const err = new BootstrapTimeoutError('boom');
    expect(err).toBeInstanceOf(BootstrapTimeoutError);
    expect(err).toBeInstanceOf(BootstrapError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('BootstrapTimeoutError');
  });

  it('BootstrapError preserves cause', () => {
    const cause = new Error('inner');
    const err = new BootstrapError('outer', { cause });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('BootstrapError');
  });
});

describe('cookieDomainMatches', () => {
  it('matches exact host', () => {
    expect(cookieDomainMatches('homegate.ch', 'homegate.ch')).toBe(true);
  });

  it('matches dot-prefixed parent for subdomain host', () => {
    expect(cookieDomainMatches('.homegate.ch', 'www.homegate.ch')).toBe(true);
  });

  it('matches dot-prefixed parent on exact host', () => {
    expect(cookieDomainMatches('.homegate.ch', 'homegate.ch')).toBe(true);
  });

  it('rejects unrelated host', () => {
    expect(cookieDomainMatches('homegate.ch', 'flatfox.ch')).toBe(false);
  });

  it('rejects host that merely contains the domain as a suffix string', () => {
    expect(cookieDomainMatches('homegate.ch', 'evilhomegate.ch')).toBe(false);
  });
});

describe('formatCookieHeader', () => {
  it('joins name=value pairs with "; "', () => {
    expect(
      formatCookieHeader([
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ]),
    ).toBe('a=1; b=2');
  });

  it('returns empty string for empty input', () => {
    expect(formatCookieHeader([])).toBe('');
  });
});

describe('bootstrapSite (live)', () => {
  it.skipIf(!process.env.WABE_E2E)(
    'harvests cookies from httpbin.org',
    async () => {
      const res = await bootstrapSite({
        target: 'https://httpbin.org/cookies/set?test=ok',
        timeoutMs: 60_000,
      });
      expect(res.cookieHeader).toContain('test=ok');
      expect(res.userAgent).toMatch(/Chrom/);
      expect(res.capturedAt).toBeGreaterThan(0);
      const match = res.cookies.find((c) => c.name === 'test');
      expect(match?.value).toBe('ok');
    },
    120_000,
  );

  it('rejects an invalid target URL with BootstrapError', async () => {
    await expect(bootstrapSite({ target: 'not-a-url' })).rejects.toBeInstanceOf(BootstrapError);
  });
});
