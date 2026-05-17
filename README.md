# Wabe

> Open-source, customizable apartment scout for the Swiss market.

**Wabe** (German for *honeycomb cell*) is a self-hosted apartment hunting agent. It continuously polls listing sources, normalizes every listing into a canonical schema, scores each one against a user-defined fit profile, and pings you on Telegram when something matches.

This repo implements **Phase 1 + 2** — the skeleton plus a minimal vertical slice with two real Swiss portal sources (Flatfox + Homegate) and a Telegram notifier. Subsequent phases add LLM scoring, enrichers (geocoding, commute), a dossier vault, application drafting, and agency-portal applicators.

## The problem

Apartment hunting in Zurich is brutal: best listings get hundreds of applications within hours. Seeing listings *before* competitors, and submitting *complete, current, tailored* dossiers within hours of a listing appearing, are the two things that move the needle. Wabe is engineered around those two principles.

## Status

Phase 1 + 2 slice. Architecture-validation milestone — proves the plugin SDK + scoring DSL + Telegram notifier loop end-to-end against two real Swiss portal APIs. Not yet a production scout; see [the spec](./.planning/notes/spec.md) for what's in vs out of scope.

## Install

```bash
git clone <repo>
cd wabe
pnpm install
pnpm build
```

Requires Node 22 (see `.nvmrc`) and pnpm 9+.

## Quickstart

```bash
pnpm wabe init       # interactive setup: writes config + .env
pnpm wabe scan       # one-shot scan; pings Telegram on matches
pnpm wabe start      # daemon mode; runs cron-driven scans
pnpm wabe list       # browse persisted listings
pnpm wabe doctor     # diagnose config / DB / plugin health
```

## Architecture

```
config.yaml  →  loader  →  pipeline                            
                              ├─ Source (flatfox, homegate)    
                              ├─ Filter (hard, AND-combined)   
                              ├─ Scorer (rule DSL, 0..100)     
                              ├─ Quota gate (daily UTC)        
                              └─ Notifier (telegram)           
                                                                
SQLite (Drizzle, FTS5) ←──── persists listings + scores + sends
```

Five plugin interfaces (`Source`, `Enricher`, `Scorer`, `Notifier`, `Applicator`); plugins are normal npm packages loaded dynamically by name from `config.yaml`'s `enabled:` list. Each plugin owns its own Zod-validated config slice.

The slice ships `Source` and `Notifier` plugins; `Enricher`, `Scorer` (LLM), and `Applicator` are type contracts only — implementations land in later phases.

## Plugin authoring 101

A plugin is an npm package that default-exports `{ kind, plugin }`:

```ts
import { z } from 'zod';
import type { Source } from '@wabe/plugin-sdk';

const ConfigSchema = z.object({ schedule: z.string().default('*/5 * * * *') });

const plugin: Source = {
  name: 'my-source',
  configSchema: ConfigSchema,
  async *fetch(ctx) {
    // yield RawListing objects
  },
};

export default { kind: 'source' as const, plugin };
```

See `plugins/source-flatfox/` for a complete reference implementation.

## Roadmap

See [`.planning/notes/spec.md`](./.planning/notes/spec.md) for the full spec and the out-of-slice items that become subsequent specs.

## Contributing

PRs welcome on bugs and small enhancements. Open an issue first for anything large. The plugin SDK is intentionally small — new sources / notifiers / enrichers belong in their own packages, not in the core.

## License

AGPL-3.0. See [`LICENSE`](./LICENSE).
