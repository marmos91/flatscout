import { Bot, InlineKeyboard } from 'grammy';
import { z } from 'zod';
import type { Context, Notifier, PluginExport } from '@wabe/plugin-sdk';
import { renderCard } from './card.js';

const ConfigSchema = z.object({
  bot_token: z.string().default('${env.TELEGRAM_BOT_TOKEN}'),
  chat_id: z.union([z.string(), z.number()]).default('${env.TELEGRAM_CHAT_ID}'),
  format: z.enum(['compact', 'verbose']).default('compact'),
});
type Config = z.infer<typeof ConfigSchema>;

/**
 * Telegram notifier plugin: renders a card via `renderCard` and posts it to
 * `chat_id` using grammY. Hard-fails fast if the bot token or chat id are
 * unresolved (`${env.*}` placeholder still present) so misconfiguration
 * surfaces immediately rather than as a confusing Telegram API error.
 */
const plugin: Notifier = {
  name: 'notifier-telegram',
  configSchema: ConfigSchema,
  async notify(event, ctx: Context) {
    const cfg = ctx.config as Config;
    if (!cfg.bot_token || cfg.bot_token.startsWith('${env.'))
      throw new Error('telegram bot_token unresolved (set TELEGRAM_BOT_TOKEN env)');
    if (!cfg.chat_id || (typeof cfg.chat_id === 'string' && cfg.chat_id.startsWith('${env.')))
      throw new Error('telegram chat_id unresolved (set TELEGRAM_CHAT_ID env)');
    // NOTE: deviated from plan — wire grammY through Node's global fetch
    // (undici-backed) instead of its default node-fetch shim, so the notifier
    // honours `setGlobalDispatcher` for tests AND avoids shipping a redundant
    // HTTP client at runtime. grammY ships an `abort-controller` polyfill
    // whose `AbortSignal` instance does NOT satisfy Node's WHATWG checks, so
    // strip the signal before delegating. Casts placate grammY's narrow
    // node-fetch-shaped fetch type.
    const wrappedFetch = (input: unknown, init?: { signal?: unknown } & Record<string, unknown>) => {
      const { signal: _ignored, ...rest } = init ?? {};
      return (globalThis.fetch as (i: unknown, r?: unknown) => Promise<unknown>)(input, rest);
    };
    const bot = new Bot(cfg.bot_token, {
      client: { fetch: wrappedFetch as unknown as never },
    });
    const card = renderCard(event);
    const kb = new InlineKeyboard();
    for (const b of card.buttons) kb.url(b.text, b.url);
    const msg = await bot.api.sendMessage(cfg.chat_id, card.text, { reply_markup: kb });
    return { ok: true, message_id: String(msg.message_id) };
  },
};

const exp: PluginExport = { kind: 'notifier', plugin };
export default exp;
