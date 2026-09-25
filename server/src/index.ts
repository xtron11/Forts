import { buildApp } from './app';
import { createBot, startBot } from './bot/bot';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrate';
import { telegramSender } from './notifications/sender';
import { NOTIFY_TEST_TIMING, NOTIFY_TIMING } from './notifications/timing';
import { startNotificationWorker } from './notifications/worker';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Логгер нужен боту раньше, чем создано приложение, — поэтому бот получает его лениво.
  const log = {
    info: (msg: string) => app.log.info(msg),
    warn: (msg: string) => app.log.warn(msg),
    error: (obj: unknown, msg?: string) => app.log.error(obj, msg),
  };
  const bot = config.botMode === 'off' ? undefined : createBot({ config, db, log });
  const app = await buildApp({ config, db, bot });
  // Схема базы всегда соответствует коду: новые миграции применяются до приёма запросов.
  await migrate(db, (msg) => app.log.info(`migrations: ${msg}`));

  let stopWorker: (() => void) | undefined;
  app.addHook('onClose', async () => {
    stopWorker?.();
    if (bot?.isRunning()) await bot.stop();
    await db.end();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: config.host, port: config.port });

  // Webhook ставится после listen: Telegram начнёт слать обновления сразу.
  if (bot && (await startBot(bot, { config, db, log }))) {
    const timing = config.notifyTestMode ? NOTIFY_TEST_TIMING : NOTIFY_TIMING;
    if (config.notifyTestMode) app.log.warn('NOTIFY_TEST_MODE: short notification delays');
    stopWorker = startNotificationWorker({ db, sender: telegramSender(bot.api), timing, webappUrl: config.webappUrl, log });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
