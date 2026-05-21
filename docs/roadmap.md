# Roadmap

Tracks what shipped recently, what's designed and queued for implementation, and what's needed before the first public release.

## Recently shipped (2026-05-21)

- **Firefox MV3 keepalive** ([#14](https://github.com/marmos91/flatscout/pull/14)) — Web Lock + `chrome.storage.session` writes on the Firefox path keep the background event page from suspending and dropping the bridge WebSocket. Chrome offscreen path untouched.
- **Documentation refresh** ([#15](https://github.com/marmos91/flatscout/pull/15)) — README rewritten as user documentation. Internal planning docs (`docs/superpowers/plans/`, `docs/superpowers/specs/`) removed. This roadmap added.
- **IS24 pagination** ([#16](https://github.com/marmos91/flatscout/pull/16)) — the bridge's read-state protocol gained sequenced pre-read actions (`eval` to drive SPA navigation, `wait_for` to gate on hydration). `source-immoscout24` now walks up to `max_pages` pages from the user's open tab by clicking the next-page control and waiting for the Pinia store to advance.
- **Bridge single-client UX + IS24 config-drift warning** ([#17](https://github.com/marmos91/flatscout/pull/17)) — second extension instance connecting with a valid token is now rejected with a structured reason and the existing socket is notified, replacing the old silent preempt loop. `source-immoscout24` warns once per scan when yaml `cfg.search` is set, since that source ingests the live tab's filter state and ignores yaml filters.

## Planned product features

Designed; awaiting implementation. Order is rough priority.

### LLM vibe scorer

A `scorer` plugin (`@flatscout/scorer-llm-vibe`) that rates each listing on qualitative dimensions a rule-based scorer cannot capture: apartment vibe, kitchen quality, neighborhood feel, photo aesthetics, description tone.

- **Interface:** consumes listing description + photos URLs; emits one or more `ScoringDim` rows that the existing weighted-sum reducer folds into the final score alongside rule-based dims.
- **Transport:** OpenAI-compatible Chat Completions API. Configurable `base_url` (defaults to `https://api.openai.com/v1`) so it can target [Bifrost](https://github.com/maximhq/bifrost) with Qwen, OpenRouter, vLLM, or vanilla OpenAI without code changes. Model, temperature, max_tokens in plugin config.
- **Vision:** support `image_url` content parts (OpenAI vision format). When the chosen model lacks vision (e.g. text-only Qwen), photos are dropped and only text dims are scored.
- **Prompting:** prompts shipped as plugin defaults but overridable via config. Rubric returns a strict JSON object validated against a Zod schema (`{ dims: Array<{ name: string; score: 0..1; rationale: string }> }`).
- **Caching:** keyed on `(canonical_key, prompt_hash, model)` in a new `scores_cache` table — re-scoring the same listing across daemon restarts is free.
- **Cost guard:** per-scan budget cap (max N listings scored per cycle); over-budget listings fall back to rule-based-only scores until next cycle.
- **Failure mode:** plugin failure never blocks the pipeline. Missing LLM dims are treated as `null` by the engine and scored on remaining dims.

### Applicator plugin

First `applicator` impl (`@flatscout/applicator-draft`). Drafts a personalized inquiry message per listing; **never auto-submits**. Final send is always a human tap, surfaced through the existing Telegram notifier with a Copy-draft button.

- **Inputs:** listing fields + a user-owned dossier YAML (name, partner, occupation, target move-in date, intro paragraph variants, language preference).
- **LLM-driven:** reuses the same OpenAI-compatible client as the vibe scorer.
- **Language:** drafts in the listing's detected portal language (DE / FR / IT / EN).
- **Output:** message body + suggested subject line, persisted on the listing row under `enriched.application_draft.{subject, body, generated_at}`.
- **Notifier integration:** Telegram message renders an inline Copy-draft button that hands the body off to the user's clipboard via a one-shot web view (out-of-band; no auto-send).
- **Non-goals:** form-filling, portal automation, dossier upload. Those are future work behind a hard human-confirmation gate.

### Telegram daily digest

A digest mode on the Telegram notifier complementing the existing per-listing fan-out.

- **Trigger:** cron-driven (`schedule: '0 8 * * *'` in plugin config). Reads listings inserted into the canonical-row table since the last digest tick.
- **Format:** one Telegram message with top N (configurable) listings ranked by score, each as a compact card (title, score, price, rooms, area, commute, URL).
- **Modes:** `realtime`, `digest`, or `both`. `digest` suppresses per-listing pings entirely; `both` keeps real-time pings but folds a morning recap on top.
- **State:** new `notifier_digest_state` table tracks `(notifier_name, last_emitted_at)` so a daemon restart doesn't re-digest the same window.
- **Selection:** respects the same filter rules as the real-time path. No new schema, just a different emit cadence.

## Release prep

Work required before the first public release on npm.

- **Code polish pass.** Consolidate duplicated patterns (data-dir resolution, undici pool wiring, logger child setup, env interpolation) into a shared `@flatscout/utils` package. Strip over-decomposed helpers and AI-flavored verbosity. Address residual lint and format issues across the workspace.
- **CI/CD release pipeline.**
  - `ci.yml` on every push and PR: lint, format-check, typecheck, test, build.
  - Changesets for independent semver per package with automated CHANGELOG generation.
  - `release.yml` on tag `v*`: builds, publishes `@flatscout/*` packages to npm with provenance, creates a GitHub Release.
  - First public version: `1.0.0`.
- **Extension distribution.** Bundle the WebExtension in the npm release. Submit `dist/chrome/` to the Chrome Web Store and `dist/firefox/` to Firefox AMO as separate manual steps.
