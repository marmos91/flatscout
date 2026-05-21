# @flatscout/agency-fingerprint

HTTP-probe-based classifier that tags a Swiss agency URL with the underlying CMS / hosting platform (immomig / casasoft / iframe-portal / schemaorg / custom).

Used by `flatscout agencies probe` and `flatscout agencies probe-portal` to bootstrap an agency registry without manual classification per entry.

## API

```ts
import { fingerprint } from '@flatscout/agency-fingerprint';

const result = await fingerprint('https://walde.ch', new AbortController().signal);
// → { platform: 'schemaorg', url: '...', status: 200, reason: '...' }
```

## Heuristics

The signature catalog (in `src/heuristics.ts`) is intentionally minimal — these are starting candidates that will be validated against real samples during the discovery spike. Add new entries by appending to the `HEURISTICS` array; order matters (first match wins).

Currently recognised:
- **immomig** — generator meta tag or `/ig.fcgi` URL pattern
- **casasoft** — `casasoft.ch` references or `/api/PropertySearch` endpoint
- **iframe-portal** — `<iframe>` from `homegate.ch` or `immoscout24.ch` (skip — no own inventory)
- **schemaorg** — embedded `application/ld+json` block with `@type: RealEstateListing`
- **custom** — fallback when nothing matches; caller decides what to do
