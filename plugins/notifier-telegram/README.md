# @wabe/notifier-telegram

## What it is

A Wabe **notifier** plugin that delivers scored listing events to a
Telegram chat. Built on [grammY](https://grammy.dev), it sends a compact
Markdown-like card per `ListingEvent` with inline URL buttons linking to
the listing and (when available) its first photo.

The plugin is **send-only**: it pushes one message per event via
`bot.api.sendMessage` and does not register update handlers, webhooks,
long-polling, or any callback-query routing. Telegram is treated as a
notification sink, not an interactive surface.

## Install & enable

The plugin is part of the Wabe monorepo and ships as
`@wabe/notifier-telegram`. Enable it in your `config.yaml`:

```yaml
notifiers:
  - name: telegram
    plugin: notifier-telegram
    enabled: true
    config:
      bot_token: "${env.TELEGRAM_BOT_TOKEN}"
      chat_id: "${env.TELEGRAM_CHAT_ID}"
      format: compact
```

Set the two env vars in your environment (see "Credentials / auth"
below) and run `wabe start`. Each scored event above your
notify-threshold will produce one Telegram message in the target chat.

## Configuration reference

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `bot_token` | string | `${env.TELEGRAM_BOT_TOKEN}` | Bot API token issued by @BotFather. Required. |
| `chat_id` | string \| number | `${env.TELEGRAM_CHAT_ID}` | Target chat id (user, group, or channel). Required. |
| `format` | enum (`compact` \| `verbose`) | `compact` | Card style. Only `compact` is rendered today; `verbose` is reserved. |

Both `bot_token` and `chat_id` support env interpolation via the standard
`${env.VAR}` syntax. The plugin fails fast at `notify()` time if either
value is still an unresolved placeholder.

## Credentials / auth

The plugin needs two pieces of information:

### `TELEGRAM_BOT_TOKEN`

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (display name + unique username
   ending in `bot`).
3. BotFather replies with an API token of the form
   `123456789:AAH...`. Export it:

   ```bash
   export TELEGRAM_BOT_TOKEN="123456789:AAH..."
   ```

   Treat this token as a secret — anyone holding it can send messages as
   your bot. Rotate via `/revoke` in BotFather if leaked.

### `TELEGRAM_CHAT_ID`

The chat id identifies where the bot will post. To obtain it:

- **Personal DM** — start a chat with your bot, send any message, then
  fetch the most recent update:

  ```bash
  curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
    | jq '.result[-1].message.chat.id'
  ```

  The returned integer (positive) is your personal chat id.

- **Group chat** — add the bot to the group, send a message that
  mentions it (e.g. `/start@your_bot`), then call `getUpdates` as
  above. Group chat ids are negative (e.g. `-100123...`).

- **Channel** — make the bot a channel admin, post a message, then call
  `getUpdates` (or use a helper like @userinfobot). Channel ids are also
  negative.

Export it:

```bash
export TELEGRAM_CHAT_ID="123456789"
```

The plugin accepts both string and numeric ids.

## Examples

Minimal config (env-driven, recommended):

```yaml
notifiers:
  - name: telegram
    plugin: notifier-telegram
    enabled: true
    config: {}
```

(`bot_token` and `chat_id` fall back to their `${env.*}` defaults.)

Hard-coded chat id for a shared family group:

```yaml
notifiers:
  - name: family-tg
    plugin: notifier-telegram
    enabled: true
    config:
      bot_token: "${env.TELEGRAM_BOT_TOKEN}"
      chat_id: -1001234567890
```

Multiple Telegram destinations from a single bot (e.g. a personal DM
plus a shared group):

```yaml
notifiers:
  - name: tg-me
    plugin: notifier-telegram
    enabled: true
    config:
      bot_token: "${env.TELEGRAM_BOT_TOKEN}"
      chat_id: "${env.TELEGRAM_CHAT_ID_ME}"
  - name: tg-family
    plugin: notifier-telegram
    enabled: true
    config:
      bot_token: "${env.TELEGRAM_BOT_TOKEN}"
      chat_id: "${env.TELEGRAM_CHAT_ID_FAMILY}"
```

## Troubleshooting

- **`telegram bot_token unresolved (set TELEGRAM_BOT_TOKEN env)`** — the
  `${env.TELEGRAM_BOT_TOKEN}` placeholder was never substituted. Export
  the env var before launching Wabe, or set `bot_token` literally in
  config.
- **`telegram chat_id unresolved (set TELEGRAM_CHAT_ID env)`** — same as
  above for `TELEGRAM_CHAT_ID`.
- **`GrammyError: Forbidden: bot was blocked by the user`** — the
  recipient blocked the bot in Telegram. Unblock the bot or pick a
  different `chat_id`.
- **`GrammyError: Bad Request: chat not found`** — wrong `chat_id`, or
  the bot is not a member of the target group/channel. For channels,
  ensure the bot is an admin. Re-run the `getUpdates` flow above.
- **`GrammyError: Unauthorized`** — the token is wrong or has been
  revoked. Generate a new one via @BotFather (`/token`).
- **No messages arrive, no error in logs** — confirm the scorer is
  emitting events above the configured notify threshold. The notifier
  only fires for events that reach it; it does not silently drop.
- **HTTP 429 / `Too Many Requests`** — Telegram rate-limits per-chat at
  ~1 msg/sec and ~20 msg/min in groups. The orchestrator's per-notifier
  circuit breaker will pause the sink on repeated failures; reduce
  scan frequency or raise the notify threshold.

## Attribution

- [grammY](https://grammy.dev) — modern Telegram Bot framework for
  Deno & Node.js, MIT licensed.
- [Telegram Bot API](https://core.telegram.org/bots/api) — official
  HTTP API used via `bot.api.sendMessage`.

## License

AGPL-3.0-or-later, matching the rest of the Wabe project.
