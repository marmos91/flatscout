import { describe, expect, it } from 'vitest';
import {
  candidateDomainsFromLegalName,
  isPortalOrCdn,
  normaliseToCandidate,
} from '../src/discovery/candidates.js';

describe('candidateDomainsFromLegalName', () => {
  it('strips entity suffixes and re-words', () => {
    expect(candidateDomainsFromLegalName('Vimova Bewirtschaftung AG')).toContain('vimova.ch');
  });
  it('produces a kebab-joined slug when multiple meaningful tokens remain', () => {
    const out = candidateDomainsFromLegalName('Walde Immobilien Zürich');
    expect(out[0]).toMatch(/walde/);
  });
  it('falls back to the raw first token when nothing else survives the filter', () => {
    expect(candidateDomainsFromLegalName('Immobilien AG')).toContain('immobilien.ch');
  });
  it('returns empty when the legal name has no extractable tokens', () => {
    expect(candidateDomainsFromLegalName('   .  .  ')).toEqual([]);
  });
});

describe('isPortalOrCdn', () => {
  it('catches known portals', () => {
    expect(isPortalOrCdn('homegate.ch')).toBe(true);
    expect(isPortalOrCdn('immoscout24.ch')).toBe(true);
    expect(isPortalOrCdn('sub.homegate.ch')).toBe(true);
  });
  it('catches CDN hosts', () => {
    expect(isPortalOrCdn('media2.homegate.ch')).toBe(true);
    expect(isPortalOrCdn('something.cloudfront.net')).toBe(true);
  });
  it('passes through real agency domains', () => {
    expect(isPortalOrCdn('walde.ch')).toBe(false);
    expect(isPortalOrCdn('ginesta.ch')).toBe(false);
  });
});

describe('normaliseToCandidate', () => {
  it('canonicalises url and slugifies host', () => {
    const c = normaliseToCandidate('http://www.walde.ch/some/path?x=1', 'lister-website');
    expect(c).not.toBeNull();
    expect(c?.website).toBe('https://walde.ch/');
    expect(c?.id).toBe('walde');
  });
  it('rejects portal hosts', () => {
    expect(normaliseToCandidate('https://www.homegate.ch/agency/h123', 'lister-website')).toBeNull();
  });
  it('returns null on malformed url', () => {
    expect(normaliseToCandidate('not a url', 'lister-website')).toBeNull();
  });
});
