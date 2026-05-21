# Contributing to Wabe

Thanks for the interest. This document covers environment, conventions, and where to put things.

## Dev setup

- **Node 22** (pinned in `.nvmrc`). Use `nvm use` or your preferred Node manager.
- **pnpm 9.12.0** (pinned via the root `packageManager` field). Corepack will pick this up automatically: `corepack enable`.
- macOS Apple Silicon is the daily-driver platform. Linux should work but sees less testing — flag platform-specific breakage in your PR.

```bash
git clone <your fork>
cd wabe
pnpm install
pnpm build
```

## Repo layout

Wabe is a pnpm + Turborepo monorepo. Workspace roots: `packages/` for the core engine, plugin SDK, server, DB, CLI and browser-bridge; `plugins/` for shipping source / enricher / notifier packages; `apps/` for the WebExtension. `examples/zurich-family/` holds the canonical config example. Start with [`README.md`](./README.md) for product-level orientation and [`CLAUDE.md`](./CLAUDE.md) for the architectural map.

## Running locally

Once `pnpm build` has run at least once, the CLI is available via `pnpm wabe <command>`:

```bash
pnpm wabe init                  # scaffold config.yaml + .env
pnpm wabe scan --source flatfox # one-shot scan against a single source
pnpm wabe start                 # daemon mode (cron + bridge)
```

The full command list, Telegram setup, and bridge pairing flow live in the README's [Run](./README.md#run) and [Browser bridge](./README.md#browser-bridge-optional) sections.

## Tests and checks

Vitest is the test runner. Tests live alongside their package as `<package>/test/<file>.test.ts`.

```bash
pnpm ci             # lint + format-check + typecheck + test — the gate PRs must pass
pnpm test           # vitest across the workspace
pnpm typecheck      # tsc --noEmit
```

**No live network calls in CI.** Source plugins mock HTTP via `undici` MockAgent; captured upstream responses go under `<package>/test/fixtures/responses/`. See `plugins/source-flatfox/test/` for the reference layout — its `client.test.ts` and `search.test.ts` show the MockAgent pattern, and `test/fixtures/responses/` shows where the JSON fixtures live.

A new source plugin should land with MockAgent-driven tests covering its happy path.

## Commit and PR conventions

Conventional-commits flavor, loose:

- Type prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Component prefix is fine and encouraged when scoped: `bridge:`, `source-immoscout24:`, `enricher-commute:`, `ext:` — see `git log` for the in-use vocabulary.
- Keep subjects concise (~72 chars). A short body is welcome when the *why* isn't obvious from the diff.
- Sign commits when possible: `git commit -S`.

For PRs:

- One topic per PR. Split sprawling changes.
- Squash merge is the default — write the PR title so it stands alone as the squashed commit subject.
- Link the issue if one exists.

## Adding a plugin

Plugins are the supported extension surface. There are five kinds, all defined in `@wabe/plugin-sdk`:

- `Source` — yields `RawListing` objects from an upstream portal.
- `Enricher` — annotates listings with derived data (e.g. commute times).
- `Scorer` — emits `ScoringDim` rows that fold into the final 0..100 score.
- `Notifier` — fans matches out to a channel (Telegram, etc.).
- `Applicator` — drafts inquiry messages. **Never auto-submits.**

Mechanics:

- Each plugin lives in its own package under `plugins/`, named `@wabe/<plugin-name>`.
- Default-export `{ kind, plugin }` per the SDK contract.
- The plugin owns its own Zod config schema. The orchestrator resolves `${env.VAR}` interpolation before Zod validation.
- Ship a `README.md` in the plugin package — config knobs, defaults, any credential requirements.
- All HTTP goes through an `undici` Pool with polite pacing and 429/5xx backoff. **Never use bare `fetch`** from a plugin.
- All logging goes through `pino` child loggers: `logger.child({ plugin: name, listing_id })`.
- Wrap external calls in try/catch — repeated failures trip the per-source circuit breaker, and an unhandled throw will take the scan run with it.

Use `plugins/source-flatfox/` as your template — it's the simplest end-to-end source (public JSON API, no auth, no bridge). For bridge-routed sources see `plugins/source-homegate/`. For non-source plugins see `plugins/enricher-commute/` and `plugins/notifier-telegram/`.

If you're adding a source that emits agency or contact data, follow the cross-source convention: top-level `agency` (string), strict `contact { phone?, email?, form_url? }`, and source-specific richness under `enriched.lister`. The README's [Extending Wabe](./README.md#extending-wabe) section has the full minimal-source code snippet.

To wire the plugin so the orchestrator can load it out of the box, add it to `@wabe/server`'s `dependencies` — the loader uses dynamic `import()` and resolves from `packages/server/node_modules/`.

## Schema and migration changes

- New fields on the canonical `Listing`: edit `packages/core/src/schemas/listing.ts`, rebuild `@wabe/core` so the JSON Schema regenerates, and update any source mappers that should populate the field.
- New CLI command: add a file under `packages/cli/src/commands/` and register it in `packages/cli/src/index.ts`.
- New DB migration: add a sequentially numbered SQL file under `packages/db/migrations/` (e.g. `0006_<name>.sql`). Migrations apply at startup via `wabe migrate`, and implicitly via `scan` / `start`.

## Reporting bugs and proposing changes

- Bugs: open an issue with the command you ran, the relevant log excerpt (the daemon logs to stdout; redirect with `pnpm wabe start > wabe.log 2>&1` if you need to capture it), and the config slice involved. Redact tokens.
- Larger changes (new plugin kind, schema additions, scheduler rework): open an issue first to align on the approach — saves both sides a round-trip on a closed PR.
- Small fixes and self-contained plugin work: a PR straight against `main` is fine.

## Code style

- [Biome](https://biomejs.dev/) handles both lint and format. Run `pnpm lint` and `pnpm format` before pushing; CI checks both.
- Zod schemas in `@wabe/core` are the single source of truth for runtime shapes. Derive TypeScript types via `z.infer<typeof Schema>` rather than maintaining a parallel `type`.

## Dependencies

- New runtime deps must be permissively licensed. MIT / BSD / Apache-2 / ISC / MPL all fine; GPL / proprietary / "source available" not acceptable.
- Add deps to the package that uses them, not the root. Run `pnpm install` from the repo root so the lockfile updates cleanly.

## License

By contributing you agree your contributions are MIT-licensed.

## Hard rules

- **NEVER auto-submit applications.** Applicator plugins draft inquiry messages only — final send is always a human tap. This is a product-level invariant; PRs that weaken it will be closed.
- **No live network calls in CI.** Mock upstreams via `undici` MockAgent and check fixtures into `<package>/test/fixtures/responses/`.
- **No bare `fetch`** from plugin code. Use an `undici` Pool so pacing, retries, and abort signals are uniform across sources.
