# Roadmap

Forward-looking features under active design. Order is rough priority, not commitment.

## LLM vibe scorer

A `scorer` plugin (`@wabe/scorer-llm-vibe`) that rates each listing on qualitative dimensions a rule-based scorer cannot capture: apartment "vibe", kitchen quality, neighborhood feel, photo aesthetics, description tone.

- **Interface:** consumes listing description + photos URLs; emits one or more `ScoringDim` rows that the existing weighted-sum reducer folds into the final score, alongside rule-based dims.
- **Transport:** OpenAI-compatible Chat Completions API. Configurable `base_url` (defaults to `https://api.openai.com/v1`) so it can target [Bifrost](https://github.com/maximhq/bifrost) with Qwen, OpenRouter, vLLM, or vanilla OpenAI without code changes. Model + temperature + max_tokens in plugin config.
- **Vision:** support `image_url` content parts (OpenAI vision format). When the chosen model lacks vision (e.g. text-only Qwen), photos are dropped and only text dims are scored.
- **Prompting:** prompts shipped as plugin defaults but overridable via config. Rubric returns a strict JSON object validated against a Zod schema (`{ dims: Array<{ name: string; score: 0..1; rationale: string }> }`).
- **Caching:** keyed on `(canonical_key, prompt_hash, model)` in a new `scores_cache` table — re-scoring same listing across daemon restarts is free.
- **Cost guard:** per-scan budget cap (e.g. max N listings scored per cycle); over-budget listings fall back to rule-based-only scores until next cycle.
- **Failure mode:** plugin failure never blocks pipeline. Missing LLM dims = treated as `null` by the engine, scored on remaining dims.

## Applicator plugin

First `applicator` impl (`@wabe/applicator-draft`). Drafts a personalized inquiry message per listing; **never auto-submits**. Final send is always a human tap, surfaced through the existing Telegram notifier with a "Copy message" button.

- **Inputs:** listing fields + a user-owned dossier YAML (name, partner, occupation, target move-in date, intro paragraph variants, language preference).
- **LLM-driven:** reuses the LLM transport from the vibe scorer; same Bifrost-compatible client.
- **Language:** drafts in the listing's detected portal language (DE / FR / IT / EN).
- **Output:** message body + suggested subject line, persisted on the listing row under `enriched.application_draft.{subject, body, generated_at}`.
- **Notifier integration:** Telegram message renders an inline "Copy draft" button that pastes the body into the user's clipboard via a one-shot web view (out-of-band; no auto-send).
- **Non-goals:** form-filling, portal automation, dossier upload. Those are future work behind a hard human-confirmation gate.

## Telegram daily digest

A digest mode on `@wabe/notifier-telegram` complementing the existing per-listing fan-out.

- **Trigger:** cron-driven (`schedule: '0 8 * * *'` in plugin config). Reads listings inserted into the canonical-row table since the last digest tick.
- **Format:** one Telegram message with top N (configurable) listings ranked by score, each as a compact card (title, score, price, rooms, area, commute, URL).
- **Modes:** `realtime`, `digest`, or `both`. `digest` suppresses per-listing pings entirely; `both` keeps real-time pings but folds a morning recap on top.
- **State:** new `notifier_digest_state` table tracks `(notifier_name, last_emitted_at)` so a daemon restart doesn't re-digest the same window.
- **Selection:** respects the same filter rules as the real-time path. No new schema, just a different emit cadence.
