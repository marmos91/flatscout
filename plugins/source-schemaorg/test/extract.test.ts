import { describe, expect, it } from 'vitest';
import { extractListing, extractOpenGraph } from '../src/extract.js';

const JSONLD_PAGE = `<html><head>
<script type="application/ld+json">{"@type":"Apartment","name":"X","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich","streetAddress":"Bahnhofstr. 1"},"geo":{"latitude":47.37,"longitude":8.54}}</script>
</head></html>`;

const OG_PAGE = `<html><head>
<meta property="og:title" content="3.5 Zi-Wohnung Zürich Erstbezug">
<meta property="og:description" content="Schöne Wohnung in Zürich">
<meta property="og:image" content="https://example.ch/photo.jpg">
<meta property="og:url" content="https://example.ch/objekt/42">
</head><body>
<h1>Erstbezug Wohnung</h1>
<p>Miete: CHF 2'850.- / Monat</p>
<p>3.5 Zimmer · 92 m²</p>
<address>Mustergasse 12, 8008 Zürich</address>
</body></html>`;

describe('extractListing — tier 1 (jsonld)', () => {
  it('extracts from JSON-LD without touching OG', () => {
    const r = extractListing(JSONLD_PAGE, 'https://example.ch/objekt/42');
    expect(r).not.toBeNull();
    expect(r?.tier).toBe('jsonld');
    expect(r?.rooms).toBe(3.5);
    expect(r?.area_m2).toBe(95);
    expect(r?.price_chf).toBe(2400);
    expect(r?.address.postal_code).toBe('8008');
    expect(r?.geo.lat).toBe(47.37);
    expect(r?.geo.lon).toBe(8.54);
  });

  it('merges a CasaWP-style split graph (RealEstateListing + Apartment + Offer)', () => {
    const casawp = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'RealEstateListing',
          '@id': 'https://x.ch/p/42#listing',
          name: 'Maisonette',
          image: ['https://cdn.casasoft.com/p/42/cover.jpg'],
          offers: { '@id': 'https://x.ch/p/42#offer' },
          mainEntity: { '@id': 'https://x.ch/p/42#property' },
        },
        {
          '@type': 'Apartment',
          '@id': 'https://x.ch/p/42#property',
          name: 'Maisonette',
          numberOfRooms: 2.5,
          floorSize: { '@type': 'QuantitativeValue', value: 56, unitCode: 'MTK' },
          address: {
            '@type': 'PostalAddress',
            streetAddress: 'Witikonerstrasse 423',
            postalCode: '8053',
            addressLocality: 'Zürich',
            addressRegion: 'ZH',
          },
          geo: { '@type': 'GeoCoordinates', latitude: 47.36, longitude: 8.59 },
        },
        {
          '@type': 'Offer',
          '@id': 'https://x.ch/p/42#offer',
          priceCurrency: 'CHF',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: 2350,
            priceCurrency: 'CHF',
            unitText: 'MONTH',
          },
        },
      ],
    })}</script>`;
    const r = extractListing(casawp, 'https://x.ch/p/42');
    expect(r).not.toBeNull();
    expect(r?.tier).toBe('jsonld');
    expect(r?.price_chf).toBe(2350);
    expect(r?.rooms).toBe(2.5);
    expect(r?.area_m2).toBe(56);
    expect(r?.address.postal_code).toBe('8053');
    expect(r?.geo.lat).toBe(47.36);
    expect(r?.photos).toContain('https://cdn.casasoft.com/p/42/cover.jpg');
  });
});

describe('extractListing — tier 2 (open graph + regex)', () => {
  it('falls back to OG + regex when JSON-LD missing', () => {
    const r = extractListing(OG_PAGE, 'https://example.ch/objekt/42');
    expect(r).not.toBeNull();
    expect(r?.tier).toBe('opengraph-regex');
    expect(r?.title).toContain('Erstbezug');
    expect(r?.photos).toEqual(['https://example.ch/photo.jpg']);
    expect(r?.price_chf).toBe(2850);
    expect(r?.rooms).toBe(3.5);
    expect(r?.area_m2).toBe(92);
    expect(r?.address.postal_code).toBe('8008');
    expect(r?.address.city).toBe('Zürich');
  });

  it('returns null when price missing', () => {
    const html = OG_PAGE.replace('Miete: CHF 2\'850.- / Monat', 'Miete auf Anfrage');
    expect(extractOpenGraph(html, 'https://x.ch')).toBeNull();
  });

  it('returns null when both rooms and area missing', () => {
    const html = `<html><body>Mieten ab CHF 1500.- / Monat - rufen Sie an</body></html>`;
    expect(extractOpenGraph(html, 'https://x.ch')).toBeNull();
  });

  it('ignores scripts when parsing prices', () => {
    const html = `<html><body><script>const x = "CHF 9999999";</script>${OG_PAGE}</body></html>`;
    const r = extractOpenGraph(html, 'https://x.ch');
    expect(r?.price_chf).toBe(2850);
  });
});
