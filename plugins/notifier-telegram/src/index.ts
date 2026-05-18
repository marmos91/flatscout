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

const plugin: Notifier = {
  name: 'notifier-telegram',
  configSchema: ConfigSchema,
  async notify(event, ctx: Context) {
    const cfg = ctx.config as Config;
    if (!cfg.bot_token || cfg.bot_token.startsWith('${env.'))
      throw new Error('telegram bot_token unresolved (set TELEGRAM_BOT_TOKEN env)');
    if (!cfg.chat_id || (typeof cfg.chat_id === 'string' && cfg.chat_id.startsWith('${env.')))
      throw new Error('telegram chat_id unresolved (set TELEGRAM_CHAT_ID env)');
    const bot = new Bot(cfg.bot_token);
    const card = renderCard(event);
    const kb = new InlineKeyboard();
    for (const b of card.buttons) kb.url(b.text, b.url);
    const msg = await bot.api.sendMessage(cfg.chat_id, card.text, { reply_markup: kb });
    return { ok: true, message_id: String(msg.message_id) };
  },
};

const exp: PluginExport = { kind: 'notifier', plugin };
export default exp;
