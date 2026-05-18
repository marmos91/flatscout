import pino, { type Logger } from 'pino';

export function createLogger(level = 'info', pretty = false): Logger {
  const opts: pino.LoggerOptions = { level };
  if (pretty) {
    return pino({ ...opts, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(opts);
}
