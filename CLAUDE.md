# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Repository overview

Wabe is a self-hosted, AGPL-3.0 apartment-hunting agent for the Swiss market. This is the **Phase 1 + 2 vertical slice** — a monorepo containing the core engine, plugin SDK, two source plugins (Flatfox public REST, Homegate mobile API), one Telegram notifier, persistence (SQLite + Drizzle), and a CLI.

## Key commands

```bash
pnpm install               # install workspace dependencies
pnpm build                 # turborepo build all packages
pnpm test                  # run all vitest suites
pnpm typecheck             # tsc --noEmit across the workspace
pnpm lint                  # biome lint
pnpm format                # biome format (writes)
pnpm format:check          # biome format check
pnpm ci                    # lint + format-check + typecheck + test
pnpm wabe <command>        # run the CLI from built output
```

## Architecture summary

- `packages/core` — Zod schemas (`Listing`, `FilterRule`, `ScoringDim`, `NotifyConfig`) + scoring engine (normalize primitives + weighted-sum reducer + JSONata wrapper).
- `packages/db` — Drizzle ORM tables + better-sqlite3 driver + migrations.
- `packages/plugin-sdk` — 5 plugin interface contracts: `Source`, `Enricher`, `Scorer`, `Notifier`, `Applicator`.
- `packages/server` — orchestrator: plugin loader (dynamic `import` by name + Zod validation), pipeline, node-cron scheduler, daily quota gate, per-source circuit-breaker.
- `packages/cli` — commander-based `wabe` binary: `init` / `scan` / `start` / `list` / `migrate` / `doctor`.
- `plugins/source-flatfox` — pure-TS client for Flatfox's public `/api/v1/public-listing/` (no auth).
- `plugins/source-homegate` — pure-TS client for `api.homegate.ch` (Basic Auth + HMAC `X-App-Id`). Wire-protocol facts translated from MIT-licensed [denysvitali/homegate-rs](https://github.com/denysvitali/homegate-rs). No Rust runtime dep.
- `plugins/notifier-telegram` — grammY send-only (URL buttons; no callback handling).

## Where to add things

- **New source / notifier / enricher / scorer / applicator**: new package under `plugins/`, `@wabe/<plugin-name>`, default export `{ kind, plugin }` per `@wabe/plugin-sdk`. Plugin owns its own Zod config schema. Plugins ALWAYS ship their own `README.md`.
- **New core schema field**: add to `packages/core/src/schemas/listing.ts`, regenerate JSON Schema (`pnpm --filter @wabe/core build`), update plugin mappers as needed.
- **New CLI command**: add file under `packages/cli/src/commands/`, register in `packages/cli/src/index.ts`.
- **New migration**: add SQL file under `packages/db/migrations/NNNN_<name>.sql` (sequential numbering). Migrations applied at startup by `wabe migrate` and implicitly by `scan` / `start`.

## Conventions

- Single source of truth: Zod schemas in `@wabe/core`. TypeScript types via `z.infer`. JSON Schema via `zod-to-json-schema` for YAML editor autocomplete.
- Plugin config slices use `${env.VAR}` interpolation for secrets. The loader resolves before Zod validation. Plugins ship documented defaults so OOB experience works without env vars.
- All HTTP via `undici` Pool (polite pacing, retry/backoff on 429/5xx, honor AbortSignal). NEVER use bare `fetch` from a plugin.
- All logging via `pino` child loggers: `logger.child({ plugin: name, listing_id })`.
- Failures are isolated per plugin call (try/catch). Repeated failures trip the per-source circuit breaker.
- **NEVER auto-submit applications.** Final send is always a human tap. (This is enforced in the spec; do not weaken it.)
- Commit messages are concise. No mention of Claude / AI / co-authored-by tags.
- Sign commits when possible (`git commit -S`).
- Slice-only: `@wabe/server`'s `dependencies` lists the three shipping plugins (`source-flatfox`, `source-homegate`, `notifier-telegram`) so the loader's dynamic `import()` resolves them at runtime from `packages/server/node_modules/` out-of-the-box.
- Published-package distribution (users `npm install @wabe/<plugin>` separately) is deferred to a later spec.

## License compliance

AGPL-3.0. New dependencies must be AGPL-compatible (MIT/BSD/Apache-2/ISC/MPL all fine; GPL-3 fine; AGPL itself fine; proprietary or "source available" licenses are NOT acceptable).

## Testing rules

- Vitest in each package. Test file colocation: `package/test/<file>.test.ts`.
- **No live network calls in CI.** Source plugins mock HTTP via `undici` MockAgent. Test fixtures (captured API responses) live in `package/test/fixtures/responses/`.
- Integration test in `@wabe/server` uses an in-test stub source + stub notifier + in-memory SQLite — verifies the full pipeline.
- Gate test in `examples/zurich-family/` enforces that example configs only reference fields the shipping sources actually populate.

## Attribution

The `@wabe/source-homegate` plugin re-implements wire-protocol facts from the MIT-licensed reference project [denysvitali/homegate-rs](https://github.com/denysvitali/homegate-rs) (HMAC algorithm + embedded app credentials). The plugin's README documents the provenance and the procedure for the user to capture fresh credentials via mitmproxy on their own phone if Homegate ever rotates them.
