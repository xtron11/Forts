/**
 * Бот Telegram на grammY: /start, /settings, /help. Работает в том же
 * процессе, что и API: в production обновления приходят на webhook
 * (маршрут в app.ts), в development — long polling.
 */
import { START_PARAM_PATTERN } from '@forts/shared';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Config } from '../config';
import { inTransaction, type Db } from '../db';
import { localeFor, t, type Locale } from '../i18n';
import { resyncNotifications } from '../notifications/store';
import { isNotificationType, NOTIFICATION_TYPES } from '../notifications/timing';
import { ensureBotPlayer, startFromBot, type BotUser } from '../players';

export const WEBHOOK_PATH = '/telegram/webhook';
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

const START_PARAM_RE = new RegExp(START_PARAM_PATTERN);

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface BotDeps {
  config: Config;
  db: Db;
  log: Logger;
  now?: () => number;
}

function botUser(ctx: Context): BotUser | undefined {
  const from = ctx.from;
  if (!from || from.is_bot) return undefined;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'Player';
  return { telegramId: from.id, name: name.slice(0, 64), languageCode: (from.language_code ?? 'en').slice(0, 16) };
}

function localeOf(ctx: Context): Locale {
  return localeFor(ctx.from?.language_code);
}

function settingsKeyboard(locale: Locale, off: readonly string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const type of NOTIFICATION_TYPES) {
    kb.text(`${off.includes(type) ? '🔕' : '✅'} ${t(locale, `notifType.${type}`)}`, `notif:${type}`).row();
  }
  return kb;
}

export function createBot({ config, db, log, now = Date.now }: BotDeps): Bot {
  const bot = new Bot(config.botToken, { client: { timeoutSeconds: 15 } });

  bot.command('start', async (ctx) => {
    const user = botUser(ctx);
    if (!user) return;
    const locale = localeOf(ctx);
    const param = ctx.match.trim();
    await startFromBot(db, user, START_PARAM_RE.test(param) ? param : undefined, now());

    const name = ctx.from?.first_name ?? user.name;
    if (!config.webappUrl) {
      await ctx.reply(t(locale, 'bot.start.noApp', { name }));
    } else {
      await ctx.reply(t(locale, 'bot.start', { name }), {
        reply_markup: new InlineKeyboard().webApp(t(locale, 'bot.play'), config.webappUrl),
      });
      // Кнопка меню на языке игрока (общая, заданная при старте, — на английском).
      await ctx.api
        .setChatMenuButton({
          chat_id: ctx.chat.id,
          menu_button: { type: 'web_app', text: t(locale, 'bot.menuButton'), web_app: { url: config.webappUrl } },
        })
        .catch((err: unknown) => log.warn(`bot: setChatMenuButton failed: ${String(err)}`));
    }
    if (config.nodeEnv === 'development') {
      await ctx.reply(`dev: open the game as this player — http://localhost:5173/?tgid=${user.telegramId}`);
    }
  });

  bot.command('help', (ctx) => ctx.reply(t(localeOf(ctx), 'bot.help')));

  bot.command('settings', async (ctx) => {
    const user = botUser(ctx);
    if (!user) return;
    const id = await ensureBotPlayer(db, user, now());
    const { rows } = await db.query<{ notifications_off: string[] }>('SELECT notifications_off FROM players WHERE id = $1', [id]);
    const locale = localeOf(ctx);
    await ctx.reply(t(locale, 'bot.settings'), { reply_markup: settingsKeyboard(locale, rows[0]?.notifications_off ?? []) });
  });

  bot.callbackQuery(/^notif:(\w+)$/, async (ctx) => {
    const user = botUser(ctx);
    const type = ctx.match[1];
    if (!user || !isNotificationType(type)) return ctx.answerCallbackQuery();
    const id = await ensureBotPlayer(db, user, now());
    const off = await inTransaction(db, async (client) => {
      // Строка игрока блокируется, как в игровых запросах и воркере.
      const { rows } = await client.query<{ notifications_off: string[] }>(
        `UPDATE players SET notifications_off = CASE
           WHEN $2 = ANY(notifications_off) THEN array_remove(notifications_off, $2)
           ELSE array_append(notifications_off, $2) END
         WHERE id = $1 RETURNING notifications_off`,
        [id, type],
      );
      await resyncNotifications(client, id, now());
      return rows[0]!.notifications_off;
    });
    const locale = localeOf(ctx);
    await ctx.answerCallbackQuery({ text: t(locale, off.includes(type) ? 'bot.settings.off' : 'bot.settings.on') });
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard(locale, off) }).catch(() => {});
  });

  bot.catch((err) => log.error(err.error, `bot: update ${err.ctx.update.update_id} failed`));
  return bot;
}

/**
 * Настройка бота при старте: команды, описания (ru и по умолчанию en),
 * кнопка меню, затем webhook (production) или long polling (development).
 * false — бот недоступен (например, тестовый токен); игра работает и без него.
 */
export async function startBot(bot: Bot, { config, log }: BotDeps): Promise<boolean> {
  try {
    await bot.init();
  } catch (err) {
    log.warn(`bot: disabled, getMe failed (check BOT_TOKEN): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  log.info(`bot: @${bot.botInfo.username}`);

  try {
    for (const locale of ['en', 'ru'] as const) {
      const language_code = locale === 'en' ? undefined : locale;
      await bot.api.setMyCommands(
        [
          { command: 'start', description: t(locale, 'cmd.start') },
          { command: 'settings', description: t(locale, 'cmd.settings') },
          { command: 'help', description: t(locale, 'cmd.help') },
        ],
        { language_code },
      );
      await bot.api.setMyDescription(t(locale, 'bot.description'), { language_code });
      await bot.api.setMyShortDescription(t(locale, 'bot.shortDescription'), { language_code });
    }
    if (config.webappUrl) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: t('en', 'bot.menuButton'), web_app: { url: config.webappUrl } },
      });
    }
  } catch (err) {
    // Не критично: например, лимит на частые изменения описания.
    log.warn(`bot: profile setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (config.botMode === 'webhook') {
    const url = `${config.publicUrl}${WEBHOOK_PATH}`;
    await bot.api.setWebhook(url, { secret_token: config.webhookSecret, allowed_updates: [...ALLOWED_UPDATES] });
    log.info(`bot: webhook set to ${url}`);
  } else {
    // start() сам снимает webhook. Не запускайте локально с токеном боевого бота!
    void bot
      .start({ allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: true, onStart: () => log.info('bot: long polling started') })
      .catch((err: unknown) => log.error(err, 'bot: polling stopped'));
  }
  return true;
}
