import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const app = await buildApp({ config, db });
  app.addHook('onClose', () => db.end());
  // Схема базы всегда соответствует коду: новые миграции применяются до приёма запросов.
  await migrate(db, (msg) => app.log.info(`migrations: ${msg}`));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
