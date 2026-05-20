import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDetail } from '../src/detail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('extractDetail (JSON-LD path)', () => {
  it('parses a RealEstateListing JSON-LD block', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
        ${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'RealEstateListing',
          name: 'Bright 3.5-room flat',
          description: 'Sunny apartment near the lake',
          numberOfRooms: 3.5,
          floorSize: { value: 78 },
          offers: { price: 2400, priceCurrency: 'CHF' },
          address: {
            streetAddress: 'Seestrasse 12',
            postalCode: '8002',
            addressLocality: 'Zürich',
            addressRegion: 'ZH',
          },
          image: ['https://img/1.jpg', 'https://img/2.jpg'],
        })}
      </script>
      </head></html>`;
    const { listing } = extractDetail(html);
    expect(listing).not.toBeNull();
    expect(listing?.numberOfRooms).toBe(3.5);
    expect(listing?.offers?.price).toBe(2400);
    expect(listing?.address?.addressLocality).toBe('Zürich');
    expect(Array.isArray(listing?.image)).toBe(true);
  });

  it('skips malformed JSON-LD blocks and keeps scanning', () => {
    const html = `
      <script type="application/ld+json">{not json}</script>
      <script type="application/ld+json">
        ${JSON.stringify({
          '@type': 'Apartment',
          numberOfRooms: 2,
          offers: { price: 1800 },
        })}
      </script>`;
    const { listing } = extractDetail(html);
    expect(listing?.numberOfRooms).toBe(2);
    expect(listing?.offers?.price).toBe(1800);
  });
});

describe('extractDetail (__NEXT_DATA__ fallback)', () => {
  it('falls back to __NEXT_DATA__ when no JSON-LD listing is present', () => {
    const next = {
      props: {
        pageProps: {
          listing: {
            numberOfRooms: 4,
            surfaceLiving: 95,
            grossPrice: 3200,
            title: 'Cozy attic',
            description: 'Two skylights',
            street: 'Bahnhofstrasse 1',
            zip: '8001',
            city: 'Zürich',
            canton: 'ZH',
            images: [{ url: 'https://img/a.jpg' }, 'https://img/b.jpg'],
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
    const { listing } = extractDetail(html);
    expect(listing).not.toBeNull();
    expect(listing?.numberOfRooms).toBe(4);
    expect(listing?.floorSize?.value).toBe(95);
    expect(listing?.offers?.price).toBe(3200);
    expect(listing?.address?.postalCode).toBe('8001');
    expect(Array.isArray(listing?.image)).toBe(true);
  });

  it('returns null when neither JSON-LD nor __NEXT_DATA__ is present', () => {
    const html = '<html><body>no scripts here</body></html>';
    expect(extractDetail(html).listing).toBeNull();
  });
});

describe('extractDetail (Pinia state path)', () => {
  it('extracts lister.phone + inquiry_contact from a real IS24 PDP fixture', () => {
    const html = readFileSync(join(__dirname, 'fixtures', 'pdp-zurich-sample.html'), 'utf8');
    const { listing } = extractDetail(html);
    expect(listing).not.toBeNull();
    expect(listing?.contact?.phone).toBe('+41774485191');
    expect(listing?.telephone).toBe('+41774485191');
    expect(listing?.inquiry_contact).toBe('Andreea');
  });

  it('shapes a synthetic Pinia state with legalName + website into provider + lister extra', () => {
    const pinia = {
      listing: {
        listing: {
          meta: { createdAt: '2026-05-19T11:05:23.700Z' },
          lister: {
            id: 'agency-xyz',
            legalName: 'ACME Immobilien AG',
            website: { value: 'https://acme.ch' },
            phone: '+41 44 555 11 22',
            contacts: {
              inquiry: { givenName: 'Maria', familyName: 'Müller', email: 'maria@acme.ch' },
              viewing: { givenName: 'Markus', familyName: 'Bauer' },
            },
          },
        },
      },
    };
    const html = `<html><script>window.__PINIA_INITIAL_STATE__ = ${JSON.stringify(pinia)};</script></html>`;
    const { listing } = extractDetail(html);
    expect(listing).not.toBeNull();
    expect(listing?.contact?.phone).toBe('+41 44 555 11 22');
    expect(listing?.contact?.email).toBe('maria@acme.ch');
    expect(listing?.provider?.name).toBe('ACME Immobilien AG');
    expect(listing?.provider?.url).toBe('https://acme.ch');
    expect(listing?.inquiry_contact).toBe('Maria Müller');
    expect(listing?.viewing_contact).toBe('Markus Bauer');
    expect(listing?.datePosted).toBe('2026-05-19T11:05:23.700Z');
  });

  it('returns null listing when Pinia state has no lister', () => {
    const html = `<html><script>window.__PINIA_INITIAL_STATE__ = ${JSON.stringify({ listing: { listing: { id: 'x' } } })};</script></html>`;
    expect(extractDetail(html).listing).toBeNull();
  });
});
