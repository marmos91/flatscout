import { describe, expect, it } from 'vitest';
import { HEURISTICS } from '../src/heuristics.js';

const samples: Record<string, string> = {
  immomig: `<html><head><meta name="generator" content="ImmoMig 5.4"></head></html>`,
  casasoft: `<html><body><script src="https://casasoft.ch/widget.js"></script></body></html>`,
  iframePortal: `<html><body><iframe src="https://homegate.ch/embed/123"></iframe></body></html>`,
  schemaorg: `<html><head><script type="application/ld+json">{"@type":"RealEstateListing","name":"x"}</script></head></html>`,
  empty: `<html><body>nothing useful here</body></html>`,
};

function match(html: string) {
  for (const h of HEURISTICS) {
    if (h.test({ html, url: 'https://x', headers: {} })) return h.platform;
  }
  return 'custom' as const;
}

describe('HEURISTICS catalog', () => {
  it('classifies immomig generator meta', () => expect(match(samples.immomig!)).toBe('immomig'));
  it('classifies casasoft widget reference', () => expect(match(samples.casasoft!)).toBe('casasoft'));
  it('classifies iframe to a portal as iframe-portal', () => expect(match(samples.iframePortal!)).toBe('iframe-portal'));
  it('classifies pure schema.org JSON-LD as schemaorg', () => expect(match(samples.schemaorg!)).toBe('schemaorg'));
  it('falls through to custom when nothing matches', () => expect(match(samples.empty!)).toBe('custom'));
});
