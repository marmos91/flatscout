import type { Logger } from 'pino';

export interface Context {
  logger: Logger;
  config: unknown;
  signal: AbortSignal;
  // db handle attached by orchestrator at runtime; typed loosely to avoid plugin-sdk → db cycle
  db: unknown;
}
