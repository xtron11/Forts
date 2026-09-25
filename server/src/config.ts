import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  nodeEnv: NodeEnv;
  botToken: string;
  databaseUrl: string;
  jwtSecret: string;
  corsOrigins: string[];
  host: string;
  port: number;
  /**
   * Как бот получает обновления: webhook в production, long polling в
   * development (без туннеля), в тестах бота нет.
   */
  botMode: 'webhook' | 'polling' | 'off';
  /** Секрет заголовка X-Telegram-Bot-Api-Secret-Token; обязателен для webhook. */
  webhookSecret?: string;
  /** Публичный https-адрес сервера — на него ставится webhook. */
  publicUrl?: string;
  /** https-адрес мини-приложения для кнопок бота; без него кнопок нет. */
  webappUrl?: string;
  /** NOTIFY_TEST_MODE: короткие задержки уведомлений; работает только в development. */
  notifyTestMode: boolean;
}

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
const EXAMPLE_JWT_SECRET = 'replace-with-at-least-32-random-characters';

/**
 * Читает server/.env (переменные окружения процесса важнее файла) и
 * проверяет все значения. При ошибке сервер не стартует и перечисляет,
 * что именно не так.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  const errors: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) errors.push(`${name} is required`);
    return value ?? '';
  };

  const nodeEnv = required('NODE_ENV');
  if (nodeEnv && !['development', 'production', 'test'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be development, production or test');
  }

  const botToken = required('BOT_TOKEN');
  if (botToken && !/^\d+:[\w-]+$/.test(botToken)) errors.push('BOT_TOKEN has invalid format (expected 123456:ABC...)');

  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) errors.push('DATABASE_URL must start with postgres://');

  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) errors.push('JWT_SECRET must be at least 32 characters');
  if (nodeEnv === 'production' && jwtSecret === EXAMPLE_JWT_SECRET) {
    errors.push('JWT_SECRET must not be the value from .env.example in production');
  }

  const corsOrigins = required('CORS_ORIGIN')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) errors.push(`CORS_ORIGIN: "${origin}" is not an origin like https://example.com`);
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be an integer 1..65535');

  const httpsUrl = (name: string): string | undefined => {
    const value = env[name]?.trim().replace(/\/+$/, '');
    if (!value) return undefined;
    if (!/^https:\/\/[^\s]+$/.test(value)) errors.push(`${name} must be an https:// URL`);
    return value;
  };
  const publicUrl = httpsUrl('PUBLIC_URL');
  const webappUrl = httpsUrl('WEBAPP_URL');
  const webhookSecret = env.WEBHOOK_SECRET?.trim() || undefined;
  if (webhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    errors.push('WEBHOOK_SECRET must be 16..256 characters A-Z a-z 0-9 _ -');
  }
  if (nodeEnv === 'production') {
    if (!publicUrl) errors.push('PUBLIC_URL is required in production (webhook address)');
    if (!webappUrl) errors.push('WEBAPP_URL is required in production (mini app address)');
    if (!webhookSecret) errors.push('WEBHOOK_SECRET is required in production');
  }
  const botMode = nodeEnv === 'production' ? 'webhook' : nodeEnv === 'development' ? 'polling' : 'off';
  const testModeFlag = ['1', 'true', 'yes'].includes(env.NOTIFY_TEST_MODE?.trim().toLowerCase() ?? '');

  if (errors.length > 0) {
    throw new Error(`Invalid configuration (see server/.env.example):\n  - ${errors.join('\n  - ')}`);
  }

  return {
    nodeEnv: nodeEnv as NodeEnv,
    botToken,
    databaseUrl,
    jwtSecret,
    corsOrigins,
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    botMode,
    webhookSecret,
    publicUrl,
    webappUrl,
    // В production флаг игнорируется: настоящие игроки всегда получают обычные задержки.
    notifyTestMode: nodeEnv === 'development' && testModeFlag,
  };
}
