/** Ручной запуск миграций: npm run db:migrate. */
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrate';

const db = createDb(loadConfig().databaseUrl);
migrate(db)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
