import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FiltersFile, RentalTermFile, ScoringFile } from '@wabe/core';
import { mapFlatfoxListing, type FlatfoxApiResult } from '@wabe/source-flatfox/dist/map.js';
import sourceHomegate from '@wabe/source-homegate';
import { mapHomegateResult, HomegateApiSchema } from '@wabe/source-homegate/dist/map.js';

// NOTE: deviated from plan — use import.meta.url instead of __dirname since the
// test runs as an ESM module (project-wide "type": "module").
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

function flatPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined) return prefix ? [prefix] : [];
  if (typeof obj !== 'object') return prefix ? [prefix] : [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => flatPaths(v, prefix ? `${prefix}.${i}` : String(i)));
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    out.push(...flatPaths(v, p));
  }
  return out;
}

function fieldsReferencedByFilters(): string[] {
  const yaml = readFileSync(join(CONFIG_DIR, 'filters.yaml'), 'utf8');
  const parsed = FiltersFile.parse(parse(yaml));
  const out: string[] = [];
  for (const f of parsed.filters) if (f.kind === 'field') out.push(f.field);
  return out;
}

function fieldsReferencedByScoring(): string[] {
  const yaml = readFileSync(join(CONFIG_DIR, 'scoring.yaml'), 'utf8');
  const parsed = ScoringFile.parse(parse(yaml));
  const out: string[] = [];
  for (const d of parsed.scoring) {
    if (d.type !== 'rule') continue;
    if (!d.metric.startsWith('=')) out.push(d.metric);
  }
  return out;
}

const flatfoxSample: FlatfoxApiResult = {
  pk: 1,
  slug: 's',
  city: 'Zürich',
  zipcode: 8000,
  price_display: 2500,
  number_of_rooms: '3.5',
  surface_living: 80,
  public_title: 't',
  latitude: 47.37,
  longitude: 8.54,
  offer_type: 'RENT',
  object_category: 'APARTMENT',
  agency: { name: 'A' },
};

describe('example-config gate', () => {
  it('every field referenced by filters/scoring is populated by the shipping source', () => {
    const referenced = new Set([...fieldsReferencedByFilters(), ...fieldsReferencedByScoring()]);
    const flatfoxFields = new Set(flatPaths(mapFlatfoxListing(flatfoxSample)));
    const missingFromFlatfox: string[] = [];
    for (const f of referenced) {
      if (!flatfoxFields.has(f)) missingFromFlatfox.push(f);
    }
    expect({ missingFromFlatfox }).toEqual({ missingFromFlatfox: [] });
  });

  it('rental_term.yaml parses against RentalTermFile', () => {
    const yaml = readFileSync(join(CONFIG_DIR, 'rental_term.yaml'), 'utf8');
    expect(() => RentalTermFile.parse(parse(yaml))).not.toThrow();
  });

  it('source-homegate.yaml parses against its plugin config schema', () => {
    const yaml = readFileSync(join(CONFIG_DIR, 'plugins', 'source-homegate.yaml'), 'utf8');
    expect(() => sourceHomegate.plugin.configSchema.parse(parse(yaml))).not.toThrow();
  });

  it('homegate mapper populates every field referenced by filters/scoring', () => {
    // Minimal envelope mirroring the iOS srp-list capture; fields here are
    // chosen to populate every key the gate test's filters + scoring touch.
    const homegateSample = HomegateApiSchema.parse({
      id: 'hg-1',
      listing: {
        id: 'hg-1',
        address: {
          geoCoordinates: { latitude: 47.37, longitude: 8.54 },
          locality: 'Zürich',
          postalCode: '8001',
        },
        prices: {
          rent: { net: 2400, extra: 200, gross: 2600 },
          currency: 'CHF',
        },
        characteristics: {
          numberOfRooms: 3.5,
          livingSpace: 80,
        },
        localization: {
          primary: 'de',
          de: { text: { title: 't', description: 'd' } },
        },
      },
    });
    const referenced = new Set([...fieldsReferencedByFilters(), ...fieldsReferencedByScoring()]);
    const homegateFields = new Set(flatPaths(mapHomegateResult(homegateSample)));
    const missingFromHomegate: string[] = [];
    for (const f of referenced) {
      if (!homegateFields.has(f)) missingFromHomegate.push(f);
    }
    expect({ missingFromHomegate }).toEqual({ missingFromHomegate: [] });
  });
});
