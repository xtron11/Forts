import { createHmac, timingSafeEqual } from 'node:crypto';

/** Пользователь из initData — только нужные поля. */
export interface TelegramInitUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type InitDataResult =
  | { ok: true; user: TelegramInitUser; authDate: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export interface ValidateOptions {
  /** Максимальный возраст auth_date в секундах. */
  maxAgeSeconds?: number;
  /** Текущее время — для тестов. */
  now?: Date;
}

export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Допуск на расхождение часов, если auth_date немного «из будущего». */
const CLOCK_SKEW_SECONDS = 60;

/** Строка для подписи: все поля, кроме hash, по алфавиту, в виде key=value через \n. */
export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
}

/** hex(HMAC_SHA256(HMAC_SHA256("WebAppData", botToken), dataCheckString)) */
export function signInitData(params: URLSearchParams, botToken: string): string {
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString(params)).digest('hex');
}

/**
 * Проверка Telegram.WebApp.initData по официальному алгоритму:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string, botToken: string, options: ValidateOptions = {}): InitDataResult {
  const { maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS, now = new Date() } = options;
  const params = new URLSearchParams(initData);

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash) || params.getAll('hash').length !== 1) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(signInitData(params, botToken), 'hex');
  const actual = Buffer.from(hash, 'hex');
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'bad_signature' };

  // Дальше данные подписаны Telegram, но всё равно проверяем их форму.
  const authDateSec = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSec) || authDateSec <= 0) return { ok: false, reason: 'malformed' };
  const ageSec = now.getTime() / 1000 - authDateSec;
  if (ageSec > maxAgeSeconds || ageSec < -CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };

  let user: unknown;
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isTelegramUser(user)) return { ok: false, reason: 'malformed' };

  return { ok: true, user, authDate: new Date(authDateSec * 1000) };
}

function isTelegramUser(value: unknown): value is TelegramInitUser {
  if (typeof value !== 'object' || value === null) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}
