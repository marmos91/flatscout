<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wabe-dark.svg">
    <img alt="Wabe — finding home in Switzerland" src="assets/wabe-light.svg" width="480">
  </picture>
</p>

> Open-source, customizable apartment scout for the Swiss market.

**Wabe** (German for *honeycomb cell*) is a self-hosted apartment-hunting agent. It continuously polls listing sources, normalizes every listing into a canonical schema, scores each one against a user-defined fit profile, and pings you on Telegram when something matches.

## The problem

Apartment hunting in Zurich is brutal: best listings get hundreds of applications within hours. Seeing listings *before* competitors, and submitting *complete, current, tailored* dossiers within hours of a listing appearing, are the two things that move the needle. Wabe is engineered around those two principles.

## What it does

- Polls five Swiss listing sources (Flatfox, Homegate, ImmoScout24, RealAdvisor, Immobilier.ch) plus an arbitrary number of agency-portal sites via a generic schema.org adapter.
- Collapses duplicates across sources into one canonical row keyed by `canonical_key`; second-source observations enrich the existing row via a priority-wins reducer (null-skip scalars, photo union, deep-merge of `enriched.*`). Notification fires only once per logical listing.
- Enriches listings with multi-modal commute times (transit + cycling + walking) via self-hosted ORS + Motis + Pelias.
- Classifies every listing as `long` / `short` / `unknown` lease via structured signals + multilingual description regex (DE / FR / IT / EN), and applies a configurable rental-term gate that drops expired offers and respects your stay window.
- Filters and scores via a YAML-defined DSL (hard filters AND-combined; weighted-sum scoring with normalized 0..100 output).
- Sends matches to Telegram in real time with inline action buttons.
- Bypasses DataDome / Cloudflare on portals that need it via an optional paired WebExtension that proxies requests through your real browser session.
- Persists everything to local SQLite (Drizzle + FTS5): listings, scores, commute cache, notification history, daily quota state.

## Architecture

```
config.yaml + commute.yaml + agencies.yaml  →  loader  →  pipeline
                                                              ├─ Sources (flatfox, homegate, immoscout24,
                                                              │          realadvisor, immobilier-ch, schemaorg ×N)
                                                              ├─ Canonical-key dedup (cross-source)
                                                              ├─ Enrichers (commute, …)
                                                              ├─ Rental-term gate (long/short, expiry)
                                                              ├─ Filter (hard, AND-combined)
                                                              ├─ Scorer (rule DSL, 0..100)
                                                              ├─ Quota gate (daily UTC)
                                                              └─ Notifier (telegram)

SQLite (Drizzle, FTS5) ←──── persists listings + scores + sends + commute cache
Browser bridge (127.0.0.1 WS) ←── extension-wabe proxies DataDome-walled requests
ORS + Motis + Pelias (docker) ←── @wabe/enricher-commute
```

Wabe is a pnpm + Turborepo monorepo built around five plugin kinds defined in `@wabe/plugin-sdk`: `Source`, `Enricher`, `Scorer`, `Notifier`, `Applicator`. Each plugin is an npm package that default-exports `{ kind, plugin }` and owns its own Zod-validated config slice. The orchestrator (`@wabe/server`) loads plugins dynamically by name from your `config.yaml`'s `enabled:` list, runs cron-driven scans (node-cron), and isolates per-plugin failures behind a circuit-breaker. The scheduler also hosts the browser bridge in-process when enabled.

## Install

```bash
git clone <repo>
cd wabe
pnpm install
pnpm build
```

Requires Node 22 (see `.nvmrc`) and pnpm 9+.

## Configure

The canonical example lives in [`examples/zurich-family/config/`](./examples/zurich-family/config/). Wabe's config is split across small YAML files so each concern stays self-contained:

| File | Purpose |
| --- | --- |
| `config.yaml` | Top-level: enabled plugins, scheduler, bridge, data dir, quota. |
| `filters.yaml` | Hard filter rules (AND-combined). Rejects non-matching listings before scoring. |
| `scoring.yaml` | Weighted scoring DSL — list of dims, weights, normalization. |
| `commute.yaml` | Commute targets (work / school / family), per-mode (`transit`, `bike`, `walk`). |
| `rental_term.yaml` | Long-term vs short-term filtering + optional stay window (from/to/min/max months). |
| `agencies.yaml` | User-owned registry of agency portals — each enabled row expands into a synthetic source via the schema.org adapter. |
| `plugins/<name>.yaml` | Per-plugin config slice; secrets via `${env.VAR}` interpolation. |

Plugins ship documented defaults so an OOB run works without env vars except where credentials are intrinsically required (Telegram bot token, Homegate OAuth).

### Telegram setup

The Telegram notifier needs a bot token and a chat id before `wabe scan` will do anything useful.

1. **Create a bot.** Open Telegram, search for [@BotFather](https://t.me/BotFather), send `/newbot`, pick a display name, then a unique username ending in `bot`. BotFather replies with an **HTTP API token** — copy it.

2. **Get the chat id.** Open the new bot in Telegram and tap **Start** (this sends `/start`). Then ask the Bot API for the latest update:

   ```bash
   curl -s "https://api.telegram.org/bot<your-token>/getUpdates?offset=-1" \
     | jq '.result[].message.chat.id'
   ```

   For a **group chat**, add the bot to the group, send any message there, then re-run the same `curl`. Group ids are negative (typically `-100…`).

3. **Wire `.env`.** In the project root, create a `.env` (gitignored) with:

   ```env
   TELEGRAM_BOT_TOKEN=<your-token>
   TELEGRAM_CHAT_ID=<your-chat-id>
   ```

   The Telegram notifier resolves these via `${env.TELEGRAM_BOT_TOKEN}` and `${env.TELEGRAM_CHAT_ID}` in `notifier-telegram.yaml`.

> **Security:** the bot token is a credential — anyone holding it can post as your bot. Never commit `.env` (it's already in `.gitignore`). If the token leaks, revoke it via `/revoke` in @BotFather and reissue.

### Rental-term filtering

Most Swiss portals freely mix permanent leases with furnished sublets, Zwischenmieten, and Blueground-style serviced flats. Wabe classifies every incoming listing using structured signals (e.g. Flatfox `object_type === 'FURNISHED_FLAT'`) plus multilingual description regex — `befristet`, `möbliert`, `auf Zeit`, `meublé`, `temporaneo`, `furnished`, `short-term`, `sublet`, etc. Patterns like `befristet bis 31.05.2025` also extract a concrete lease end date, which the pre-filter gate uses to drop already-expired listings.

```yaml
rental_term:
  mode: long              # 'long' | 'short'
  exclude_unknown: false  # when true, also drops unknown-term listings
```

For short-term searches, narrow the match with an optional stay window:

```yaml
rental_term:
  mode: short
  stay:
    from: 2026-06-01      # listing must be available by this date
    to:   2026-08-31      # listing must remain available through this date
    min_months: 1
    max_months: 6
```

If `rental_term.yaml` is absent the engine defaults to `mode: long, exclude_unknown: false`. The `wabe init` flow prompts for these interactively.

## Run

```bash
pnpm wabe init                  # interactive setup: writes config + .env
pnpm wabe migrate               # apply pending DB migrations (scan/start do this implicitly)
pnpm wabe scan                  # one-shot scan; pings Telegram on matches
pnpm wabe start                 # daemon mode; runs cron-driven scans (hosts the bridge)
pnpm wabe list                  # browse persisted listings
pnpm wabe doctor                # diagnose config / DB / plugin / bridge health
pnpm wabe purge                 # clear listings / scores / notifications / quota
pnpm wabe bridge pair           # print URL + token to paste into the extension
pnpm wabe bridge status         # bridge connection state (reads bridge.status.json)
pnpm wabe agencies discover     # auto-discover agency portals from configured seeds
pnpm wabe agencies probe <url>  # classify an agency portal (platform fingerprint)
pnpm wabe agencies probe-portal <portal>  # re-probe a known portal
pnpm wabe agencies validate <file>        # validate agencies.yaml against the schema
pnpm wabe agencies stats        # registry stats: enabled / disabled / per-platform
pnpm wabe login homegate        # OAuth2 + PKCE login for user-bound Homegate features
pnpm wabe logout homegate       # revoke local Homegate credentials
```

> **Homegate / ImmoScout24 notes.** These portals sit behind DataDome and require the browser bridge (see below). Without a paired extension the sources fail fast at plugin init. Anonymous Flatfox / RealAdvisor / Immobilier.ch / schema.org agency scans do not need the bridge.

## Browser bridge (optional)

Some Swiss portals (Homegate, ImmoScout24) sit behind DataDome / Cloudflare anti-bot stacks that fingerprint TLS + HTTP/2 in addition to cookies. Wabe ships an opt-in **browser bridge** that turns the user's own Chrome or Firefox into the upstream HTTPS transport, so the request goes out as ordinary human browsing.

- `@wabe/browser-bridge` runs a `127.0.0.1`-only WebSocket server inside `wabe start`, paired with one extension via a 64-hex shared secret. A heartbeat file at `${dataDir}/bridge.status.json` lets sibling commands read connection state without opening a second WS client. The same server exposes `/dispatch` so sibling processes (`wabe scan --source X`) can fan their requests through the daemon → extension instead of needing their own paired extension.
- `apps/extension-wabe` is a manifest v3 WebExtension (Chrome + Firefox via separate `dist/chrome/` and `dist/firefox/` builds). On a bridge request the extension opens (or reuses) a hidden tab loaded at the target's homepage and runs `chrome.scripting.executeScript({ world: 'MAIN' })` to perform `fetch()` inside the page's own context. A `declarative_net_request` rule additionally rewrites `Origin` / `Referer` at the network layer. An offscreen document keeps the Chrome WS warm across MV3 service-worker idle.

Setup:

```bash
# 1. Enable the bridge in config.yaml
#    bridge:
#      enabled: true
#      port: 8431

# 2. Build the extension (both Chrome + Firefox dists)
pnpm --filter @wabe/extension-wabe build
# Output: apps/extension-wabe/dist/chrome/ and dist/firefox/

# 3. Start the daemon (this also starts the bridge)
pnpm wabe start

# 4. Get the pairing URL + token
pnpm wabe bridge pair

# 5. Load the extension
#    Chrome:  chrome://extensions → Developer mode → Load unpacked → apps/extension-wabe/dist/chrome/
#    Firefox: about:debugging → This Firefox → Load Temporary Add-on → apps/extension-wabe/dist/firefox/manifest.json
# 6. Open the extension popup, paste URL + token, click Save & connect.

# 7. Verify
pnpm wabe bridge status     # expect: connected on port 8431 …
pnpm wabe doctor            # expect: [OK ] browser bridge — connected …
```

<p align="center">
  <img alt="Wabe extension popup — paired" src="assets/wabe-extension.png" width="360">
</p>

Headless deployments without a GUI cannot use Homegate or ImmoScout24 — both require the paired extension. The other shipped sources work over plain undici and need no bridge.

For technical depth on why the bridge exists and how it defeats DataDome's fingerprinting, see [`docs/research/2026-05-18-homegate-investigation.md`](./docs/research/2026-05-18-homegate-investigation.md).

### Known limitations

- **Chrome** uses an offscreen document to keep the WS warm across MV3 service-worker idle. **Firefox** has no offscreen API; the background event page still suspends after ~30 s and reconnects on the next `chrome.alarms` tick. For unattended Firefox runs, keep DevTools open on the background page.
- **First request to each origin opens a new tab.** The tab is hidden (`active: false`) but visible in the tab strip. The page must reach `complete` and run any DataDome JS challenge before the bridge can dispatch; subsequent requests reuse the same tab.
- **The bridge is single-tenant.** One extension at a time per Wabe agent; a newer pairing preempts an older one server-side.
- **Distribution is unpacked-load only.** Chrome Web Store / AMO submission is deferred.

## Extending Wabe

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

The five plugin kinds in `@wabe/plugin-sdk`:

- **`Source`** — yields `RawListing` objects from an upstream portal. See `plugins/source-flatfox/` (simple JSON API) and `plugins/source-homegate/` (bridge-driven transport + OAuth login) as references.
- **`Enricher`** — annotates listings with derived data between dedup and the rental-term gate. See `plugins/enricher-commute/`.
- **`Scorer`** — emits one or more `ScoringDim` rows, folded into the final 0..100 score by the weighted-sum reducer.
- **`Notifier`** — fan-out to a channel. See `plugins/notifier-telegram/`.
- **`Applicator`** — drafts inquiry messages. **Never auto-submits** — final send is always a human tap.

Plugins ship their own `README.md`. Cross-source lister metadata follows a shared shape — `agency` (top-level), strict `contact { phone?, email?, form_url? }`, and `enriched.lister` for source-specific richness. Mirror this when adding sources.

## Status

What works today: five live sources collapsed into one canonical row per logical listing, agency-portal expansion via schema.org adapter, browser bridge (Chrome + Firefox) for DataDome-walled portals, multi-modal commute enrichment via self-hosted ORS + Motis + Pelias, rental-term gating with multilingual classification, weighted rule-based scoring, Telegram real-time notification, daily quota and per-source circuit-breaker. Persistence to local SQLite. End-to-end proven against real Swiss portals.

Not yet a production scout — LLM "vibe" scoring, applicator drafting, and a Telegram daily digest are on the [roadmap](./docs/roadmap.md).

## Contributing

PRs welcome on bugs and small enhancements. Open an issue first for anything large. The plugin SDK is intentionally small — new sources / notifiers / enrichers belong in their own packages, not in the core.

## License

AGPL-3.0. See [`LICENSE`](./LICENSE).
