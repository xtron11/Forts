/**
 * Применяет SQL-миграции из server/migrations по порядку имён. Каждая
 * выполняется в своей транзакции и записывается в schema_migrations,
 * повторный запуск применяет только новые. Сервер вызывает migrate при
 * старте; вручную — npm run db:migrate (src/migrateCli.ts).
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inTransaction, type Db } from './db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
    await inTransaction(db, async (client) => {
      // Блокировка не даёт двум одновременным запускам применить одно и то же.
      await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log(`applied ${file}`);
      count++;
    });
  }
  log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
}
