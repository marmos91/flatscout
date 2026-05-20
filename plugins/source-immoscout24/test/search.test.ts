import { describe, expect, it } from 'vitest';
import { SearchConfig, buildSrpUrl } from '../src/search.js';

describe('SearchConfig', () => {
  it('applies sensible defaults', () => {
    const cfg = SearchConfig.parse({});
    expect(cfg.language).toBe('en');
    expect(cfg.property_type).toBe('APARTMENT_OR_HOUSE');
    expect(cfg.offer_type).toBe('RENT');
    expect(cfg.sort_by).toBe('dateCreated');
    expect(cfg.sort_direction).toBe('desc');
  });
});

describe('buildSrpUrl', () => {
  it('emits the root URL with no location and an=G when zipcodes is empty', () => {
    const url = buildSrpUrl(SearchConfig.parse({}), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1');
  });

  it('uses the city-<slug> path when a single known zipcode resolves', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [8001] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G&pn=1');
  });

  it('falls back to wzip param for unknown zipcodes', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [5000] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1&wzip=5000');
  });

  it('collapses to single slug when all multi-zip values map to the same city', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [8001, 8002] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent/city-zurich?an=G&pn=1');
  });

  it('emits multi-zip via comma-joined wzip when zips span different/unknown cities', () => {
    const url = buildSrpUrl(SearchConfig.parse({ zipcodes: [5000, 5001] }), 1);
    expect(url).toBe('https://www.immoscout24.ch/en/real-estate/rent?an=G&pn=1&wzip=5000%2C5001');
  });

  it('translates filter fields into query params', () => {
    const cfg = SearchConfig.parse({
      zipcodes: [8001],
      price_min: 1500,
      price_max: 3000,
      rooms_min: 2,
      rooms_max: 4,
      surface_min: 60,
      sort_by: 'price',
      sort_direction: 'asc',
    });
    const url = buildSrpUrl(cfg, 3);
    expect(url).toContain('/en/real-estate/rent/city-zurich');
    expect(url).toContain('&pn=3');
    expect(url).toContain('&ps=1500');
    expect(url).toContain('&pe=3000');
    expect(url).toContain('&nrf=2');
    expect(url).toContain('&nrt=4');
    expect(url).toContain('&slf=60');
    expect(url).toContain('&srt=price');
    expect(url).toContain('&sdt=asc');
  });

  it('honors language', () => {
    const url = buildSrpUrl(SearchConfig.parse({ language: 'de' }), 1);
    expect(url).toContain('/de/immobilien/mieten');
  });

  it('encodes property_type as category param when not the default', () => {
    const url = buildSrpUrl(SearchConfig.parse({ property_type: 'HOUSE' }), 1);
    expect(url).toContain('&cat=house');
  });
});
