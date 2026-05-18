import { describe, expect, it } from 'vitest';
import { extractJsonLd } from '../src/detail.js';

describe('extractJsonLd', () => {
  it('picks up @type: RealEstateListing', () => {
    const html = `<script type="application/ld+json">{"@type":"RealEstateListing","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich"}}</script>`;
    const out = extractJsonLd(html);
    expect(out.listing?.numberOfRooms).toBe('3.5');
    expect(out.listing?.offers?.price).toBe('2400');
  });
  it('picks up @type: Apartment via nested @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"x"},{"@type":"Apartment","numberOfRooms":4}]}</script>`;
    expect(extractJsonLd(html).listing?.['@type']).toBe('Apartment');
  });
  it('returns null when no matching type', () => {
    expect(extractJsonLd('<script type="application/ld+json">{"@type":"Article"}</script>')).toEqual({
      listing: null,
    });
  });
});
