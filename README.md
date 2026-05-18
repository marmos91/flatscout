# Wabe

> Open-source, customizable apartment scout for the Swiss market.

**Wabe** (German for *honeycomb cell*) is a self-hosted apartment hunting agent. It continuously polls listing sources, normalizes every listing into a canonical schema, scores each one against a user-defined fit profile, and pings you on Telegram when something matches.

This repo implements **Phase 1 + 2** — the skeleton plus a minimal vertical slice with one real Swiss portal source (Flatfox) and a Telegram notifier. A Homegate source plugin was scoped originally but is deferred to its own future spec — Homegate's API moved to Auth0 + Google SSO behind a DataDome/Cloudflare anti-bot stack, which is out of scope for this slice. See `docs/research/2026-05-18-homegate-investigation.md`. Subsequent phases add LLM scoring, enrichers (geocoding, commute), a dossier vault, application drafting, and agency-portal applicators.

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
```

### Telegram setup

Wabe pushes every matching listing to a Telegram chat, so the notifier needs a
bot token and a chat id before `wabe scan` will do anything useful.

1. **Create a bot.** Open Telegram, search for [@BotFather](https://t.me/BotFather),
   send `/newbot`, pick a display name, then a unique username ending in `bot`.
   BotFather replies with an **HTTP API token** — copy it.

2. **Get the chat id.** Open the new bot in Telegram and tap **Start** (this
   sends `/start`). Then ask the Bot API for the latest update:

   ```bash
   curl -s "https://api.telegram.org/bot<your-token>/getUpdates?offset=-1" \
     | jq '.result[].message.chat.id'
   ```

   For a **group chat**, add the bot to the group, send any message there,
   then re-run the same `curl`. Group ids are negative (typically
   `-100…`).

3. **Wire `.env`.** In the project root, create a `.env` (gitignored) with:

   ```env
   TELEGRAM_BOT_TOKEN=<your-token>
   TELEGRAM_CHAT_ID=<your-chat-id>
   ```

   The Telegram notifier resolves these via `${env.TELEGRAM_BOT_TOKEN}` and
   `${env.TELEGRAM_CHAT_ID}` in `notifier-telegram.yaml`.

> **Security:** the bot token is a credential — anyone holding it can post
> as your bot. Never commit `.env` (it's already in `.gitignore`). If the
> token leaks, revoke it via `/revoke` in @BotFather and reissue.

### Run the pipeline

```bash
pnpm wabe scan       # one-shot scan; pings Telegram on matches
pnpm wabe start      # daemon mode; runs cron-driven scans
pnpm wabe list       # browse persisted listings
pnpm wabe doctor     # diagnose config / DB / plugin health
```

## Architecture

```
config.yaml  →  loader  →  pipeline                            
                              ├─ Source (flatfox)              
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
