import { describe, expect, it } from 'vitest';
import { extractJsonLd } from '../src/detail.js';

describe('extractJsonLd', () => {
  it('picks up @type: RealEstateListing', () => {
    const html = `<script type="application/ld+json">{"@type":"RealEstateListing","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich"}}</script>`;
    const out = extractJsonLd(html);
    expect(out?.numberOfRooms).toBe('3.5');
    expect(out?.offers?.price).toBe('2400');
  });
  it('picks up @type: Apartment via nested @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"x"},{"@type":"Apartment","numberOfRooms":4}]}</script>`;
    expect(extractJsonLd(html)?.['@type']).toBe('Apartment');
  });
  it('picks up @type: SingleFamilyResidence (Ginesta-style)', () => {
    const html = `<script type="application/ld+json">{"@type":"SingleFamilyResidence","name":"Villa","offers":{"price":"4500","priceCurrency":"CHF"},"floorSize":{"value":"180"}}</script>`;
    const out = extractJsonLd(html);
    expect(out?.['@type']).toBe('SingleFamilyResidence');
    expect(out?.offers?.price).toBe('4500');
  });
  it('returns null when no matching type', () => {
    expect(extractJsonLd('<script type="application/ld+json">{"@type":"Article"}</script>')).toBeNull();
  });
});
