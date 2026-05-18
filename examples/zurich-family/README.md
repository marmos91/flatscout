# Zurich Family — reference Wabe config

A worked example targeting 3+ room rentals in Zürich under CHF 5000/month, scored
on rent-value, size, and rooms. Uses both shipping source plugins
(`source-flatfox`, `source-homegate`) and the `notifier-telegram` sink.

## What this config does

- **Sources:** Flatfox (public REST, no auth) and Homegate (mobile API, HMAC).
- **Filters:** rooms ≥ 3, total price ≤ 5000 CHF, country = CH.
- **Scoring:** rent-value (50 %, lower better), size (30 %, bigger better),
  rooms (20 %, more better). Notifies when final score ≥ 70.
- **Quota:** 5 Telegram messages per day max.
- **Cadence:** every 5 minutes per source.

## Install

1. Copy the config tree into your wabe config directory:

   ```bash
   mkdir -p ~/.config/wabe
   cp -R examples/zurich-family/config/* ~/.config/wabe/
   ```

2. Create a `.env` next to the config (or export the variables in your shell):

   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC-…
   TELEGRAM_CHAT_ID=987654321

   # Optional — only needed if you enable the homegate source
   HOMEGATE_BASIC_USER=…
   HOMEGATE_BASIC_PASS=…
   HOMEGATE_APP_SECRET=…
   ```

3. Initialise the database and verify environment:

   ```bash
   pnpm wabe migrate
   pnpm wabe doctor
   ```

4. Run a one-shot scan, or start the daemon:

   ```bash
   pnpm wabe scan            # single pipeline pass
   pnpm wabe start           # cron-scheduled daemon
   ```

## Customising

- Drop sources you don't want by removing them from `enabled.sources` in
  `config.yaml` — no code changes needed.
- Adjust thresholds in `scoring.yaml` (`notify.threshold`, `notify.daily_quota`).
- Tighten filters by editing `filters.yaml`. Any field referenced must be
  populated by every enabled source mapper — the gate test in
  `examples/zurich-family/test/gate.test.ts` enforces this for the shipping
  config.
