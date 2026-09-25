import pg from 'pg';

// bigint (int8) приходит строкой; наши id и telegram_id заведомо меньше 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = pg.Pool;

export function createDb(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Выполняет fn в транзакции; при исключении откатывает. */
export async function inTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
