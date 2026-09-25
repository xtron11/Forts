/**
 * Тестовая база: отдельная БД forts_test на том же Postgres, что и для
 * разработки (npm run db:up). Создаётся и мигрируется автоматически.
 * Адрес можно переопределить через TEST_DATABASE_URL.
 */
import pg from 'pg';
import type { Config } from './config';
import { createDb, type Db } from './db';
import { migrate } from './migrate';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://forts:forts@localhost:5433/forts_test';

export const TEST_CONFIG: Config = {
  nodeEnv: 'test',
  botToken: '123456789:TEST-token_for-unit-tests',
  databaseUrl: TEST_DATABASE_URL,
  jwtSecret: 'test-secret-test-secret-test-secret-000',
  corsOrigins: ['http://localhost:5173'],
  host: '127.0.0.1',
  port: 0,
};

/** Создаёт тестовую базу, если её нет, и применяет миграции. undefined — Postgres недоступен. */
export async function openTestDb(): Promise<Db | undefined> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch {
    return undefined;
  }
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  const db = createDb(TEST_DATABASE_URL);
  await migrate(db, () => {});
  return db;
}
