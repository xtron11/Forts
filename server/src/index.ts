import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  await db.query('SELECT 1'); // Нет базы — лучше узнать сразу, а не на первом запросе.

  const app = await buildApp({ config, db });
  app.addHook('onClose', () => db.end());

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
