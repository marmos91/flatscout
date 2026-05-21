import { describe, expect, it } from 'vitest';
import {
  candidateDomainsFromLegalName,
  extractDescriptionUrls,
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

describe('extractDescriptionUrls (Path B)', () => {
  it('pulls full https URLs from description text', () => {
    const cs = extractDescriptionUrls(
      'Erstbezug — Mehr Infos auf https://wohnpark-buchholzstrasse.ch und unter https://walde.ch.',
    );
    expect(cs.map((c) => c.id)).toEqual(expect.arrayContaining(['wohnpark-buchholzstrasse', 'walde']));
    expect(cs.every((c) => c.source === 'pdp-url-mined')).toBe(true);
  });

  it('catches bare www.foo.ch hyperlinks not preceded by a scheme', () => {
    const cs = extractDescriptionUrls('Neubau — siehe www.example-projekt.ch für Details.');
    expect(cs.find((c) => c.id === 'example-projekt')).toBeDefined();
  });

  it('drops portal/CDN domains', () => {
    const cs = extractDescriptionUrls(
      'Mehr unter https://www.homegate.ch/listing/123 und https://example-projekt.ch/',
    );
    expect(cs.map((c) => c.id)).not.toContain('homegate');
    expect(cs.map((c) => c.id)).toContain('example-projekt');
  });

  it('dedupes by id', () => {
    const cs = extractDescriptionUrls('https://walde.ch/x https://walde.ch/y www.walde.ch https://walde.ch');
    expect(cs.filter((c) => c.id === 'walde')).toHaveLength(1);
  });

  it('trims trailing punctuation from extracted URLs', () => {
    const cs = extractDescriptionUrls('Siehe https://example.ch/.');
    expect(cs[0]?.id).toBe('example');
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
