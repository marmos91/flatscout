# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Repository overview

Wabe is a self-hosted, AGPL-3.0 apartment-hunting agent for the Swiss market. The monorepo ships the core engine, plugin SDK, five source plugins (Flatfox, Homegate, ImmoScout24 sitemap, RealAdvisor, Immobilier.ch + the generic schema.org adapter), a Telegram notifier, persistence (SQLite + Drizzle), a CLI, and the browser-bridge subsystem (`@wabe/browser-bridge` + `apps/extension-wabe`) used to bypass anti-bot stacks on DataDome/Cloudflare-protected portals.

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
- `packages/server` — orchestrator: plugin loader (dynamic `import` by name + Zod validation), pipeline, node-cron scheduler, daily quota gate, per-source circuit-breaker, shutdown-hook lifecycle. Starts `@wabe/browser-bridge` when `top.bridge.enabled` is true.
- `packages/cli` — commander-based `wabe` binary: `init` / `scan` / `start` / `list` / `migrate` / `doctor` / `bridge {pair,status}`.
- `packages/browser-bridge` — `@wabe/browser-bridge`: 127.0.0.1-only WebSocket server + shared-secret handshake + heartbeat file + `Transport` interface + `BrowserBridgeTransport` adapter consumed by source plugins.
- `apps/extension-wabe` — manifest v3 WebExtension (Chrome + Firefox via separate `dist/<browser>/` builds). Service worker / event-page proxies bridge requests by running `chrome.scripting.executeScript({ world: 'MAIN' })` inside a hidden tab on the target origin, so DataDome's JS-challenge hook on `window.fetch` signs the request.
- `plugins/source-flatfox` — pure-TS client for Flatfox's public `/api/v1/public-listing/` (no auth).
- `plugins/source-homegate` — paginated iOS-style search API; runtime transport selector (bridge → playwright → undici), full-projection response (no `fieldset='srp-list'`).
- `plugins/source-immoscout24-sitemap` — Phase A sitemap discovery; Phase B PDP enrichment through the bridge.
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
- Slice-only: `@wabe/server`'s `dependencies` lists the shipping plugins so the loader's dynamic `import()` resolves them at runtime from `packages/server/node_modules/` out-of-the-box.
- Published-package distribution (users `npm install @wabe/<plugin>` separately) is deferred to a later spec.
- Cross-source lister normalisation: source plugins emit agency / contact / lister metadata under a shared shape — `agency` (top-level string), strict `contact { phone?, email?, form_url? }`, and `enriched.lister` for source-specific richness (`legal_name`, `website`, `logo_url`, `inquiry_contact`, `viewing_contact`, `address_locality`). Mirror this convention when adding new sources.
- Bridge mode supports two contexts. The daemon (`wabe start`) hosts the bridge server in-process; its source plugins dispatch via the `getCurrentBridge()` singleton (`BrowserBridgeTransport`). Sibling processes (`wabe scan --source ...`) read `${dataDir}/bridge.status.json`, open a `/dispatch` WebSocket to the daemon, and dispatch via `DaemonBridgeTransport`. If neither path is available, DataDome-protected sources fail fast at plugin init.

## License compliance

AGPL-3.0. New dependencies must be AGPL-compatible (MIT/BSD/Apache-2/ISC/MPL all fine; GPL-3 fine; AGPL itself fine; proprietary or "source available" licenses are NOT acceptable).

## Testing rules

- Vitest in each package. Test file colocation: `package/test/<file>.test.ts`.
- **No live network calls in CI.** Source plugins mock HTTP via `undici` MockAgent. Test fixtures (captured API responses) live in `package/test/fixtures/responses/`.
- Integration test in `@wabe/server` uses an in-test stub source + stub notifier + in-memory SQLite — verifies the full pipeline.
- Gate test in `examples/zurich-family/` enforces that example configs only reference fields the shipping sources actually populate.

## Browser bridge

DataDome on `api.homegate.ch` (and equivalents on ImmoScout24) fingerprints the request beyond cookies — TLS JA3/JA4, HTTP/2 frame order, and a JS-challenge-derived header injected by the page's hooked `fetch`. The bridge bypasses all of this by routing the request through `chrome.scripting.executeScript({ world: 'MAIN' })` inside a hidden tab loaded at the target's homepage; the request goes out from the genuine page context with the genuine hooked fetch.

- Server: `@wabe/browser-bridge` starts inside `wabe start` on `127.0.0.1:8431`.
- Pairing: `wabe bridge pair` prints URL + 64-hex token; the extension's popup persists both in `chrome.storage.local`.
- Status: `wabe bridge status` and `wabe doctor` read `${dataDir}/bridge.status.json` (no second WS client).
- Headers: a `declarative_net_request` ruleset on the extension rewrites `Origin` / `Referer` for `api.homegate.ch` + `api.immoscout24.ch` requests.
- Chrome MV3 keeps the WebSocket open via an offscreen document; the SW only wakes per-request. Firefox MV3 has no offscreen API — it still suspends after ~30 s idle and reconnects on the next alarm tick. For unattended Firefox runs, keep DevTools open on the background page; offscreen-equivalent for Firefox is a deferred follow-up.

See `docs/research/2026-05-18-homegate-investigation.md` for the original DataDome / Auth0 investigation that motivated this design.
