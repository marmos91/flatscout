import pino, { type Logger } from 'pino';

/**
 * Builds a pino logger at the requested level. When `pretty` is true (typical
 * for interactive TTYs), routes output through `pino-pretty` with colours.
 */
export function createLogger(level = 'info', pretty = false): Logger {
  const opts: pino.LoggerOptions = { level };
  if (pretty) {
    return pino({ ...opts, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(opts);
}
