import { describe, expect, it } from 'vitest';
import { extractJsonLd } from '../src/detail.js';

describe('extractJsonLd', () => {
  it('extracts Product and Residence blocks', () => {
    const html = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Flat","offers":{"price":"3200","priceCurrency":"CHF"},"image":"https://x/i.jpg"}</script>
<script type="application/ld+json">{"@type":"Residence","address":{"streetAddress":"Forchstrasse 187","postalCode":"8008","addressLocality":"Zürich"},"numberOfRooms":"4.5","floorSize":{"value":"112"}}</script>
</head></html>`;
    const out = extractJsonLd(html);
    expect(out.product?.offers?.price).toBe('3200');
    expect(out.residence?.address?.postalCode).toBe('8008');
    expect(out.residence?.numberOfRooms).toBe('4.5');
  });
  it('returns nulls when no JSON-LD blocks present', () => {
    expect(extractJsonLd('<html><body>no json-ld here</body></html>')).toEqual({
      product: null,
      residence: null,
    });
  });
});
