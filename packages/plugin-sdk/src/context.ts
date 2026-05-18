import type { Logger } from 'pino';

/**
 * Runtime context passed to every plugin entry point.
 *
 * `config` is the plugin's validated config (typed loosely so the SDK doesn't
 * depend on `@wabe/core`); `db` is the orchestrator-attached SQLite handle,
 * also typed loosely to avoid a `plugin-sdk` → `@wabe/db` cycle. `signal`
 * propagates shutdown / cancellation.
 */
export interface Context {
  logger: Logger;
  config: unknown;
  signal: AbortSignal;
  // db handle attached by orchestrator at runtime; typed loosely to avoid plugin-sdk → db cycle
  db: unknown;
}
