import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Listing, FiltersFile, ScoringFile } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', '..', '..', 'examples', 'schema');
mkdirSync(outDir, { recursive: true });
const write = (name: string, schema: object) =>
  writeFileSync(join(outDir, name), `${JSON.stringify(schema, null, 2)}\n`);
write('listing.schema.json', zodToJsonSchema(Listing, 'Listing'));
write('filters.schema.json', zodToJsonSchema(FiltersFile, 'FiltersFile'));
write('scoring.schema.json', zodToJsonSchema(ScoringFile, 'ScoringFile'));
console.log(`wrote schemas to ${outDir}`);
