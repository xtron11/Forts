import { NOTIFICATION_START_PREFIX, STARTING_BUILDINGS, STARTING_RESOURCES } from '@forts/shared';
import type pg from 'pg';
import { inTransaction, type Db } from './db';
import { trackEvent } from './events';
import { resyncNotifications } from './notifications/store';
import { isValidTimezone } from './notifications/policy';

export interface LoginProfile {
  telegramId: number;
  name: string;
  languageCode: string;
  /** allows_write_to_pm из initData; undefined — не менять. */
  allowsWriteToPm?: boolean;
  /** Часовой пояс устройства (IANA); неверный игнорируется. */
  timezone?: string;
  /** Параметр запуска: источник прихода или notif_<тип> — вход по уведомлению. */
  startParam?: string;
}

/** Источник прихода — параметр запуска, если это не кнопка уведомления. */
function sourceOf(startParam: string | undefined): string | null {
  return startParam && !startParam.startsWith(NOTIFICATION_START_PREFIX) ? startParam : null;
}

/** Создаёт игрока со стартовыми ресурсами и зданиями; undefined — такой telegram_id уже есть. */
async function insertPlayer(
  client: pg.PoolClient,
  profile: { telegramId: number; name: string; languageCode: string },
  extra: {
    source: string | null;
    timezone: string | null;
    allowsWriteToPm: boolean;
    canMessage: boolean;
    now: number;
    /** Когда игрок «был в игре»; по умолчанию now. */
    lastSeenAt?: number;
  },
): Promise<number | undefined> {
  // При одновременном первом входе второй INSERT дождётся первого и ничего не вставит.
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO players (telegram_id, name, language_code, gold, food, source, timezone, allows_write_to_pm, can_message, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (telegram_id) DO NOTHING
     RETURNING id`,
    [
      profile.telegramId,
      profile.name,
      profile.languageCode,
      STARTING_RESOURCES.gold,
      STARTING_RESOURCES.food,
      extra.source,
      extra.timezone,
      extra.allowsWriteToPm,
      extra.canMessage,
      new Date(extra.now),
      new Date(extra.lastSeenAt ?? extra.now),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) return undefined;
  for (const b of STARTING_BUILDINGS) {
    await client.query('INSERT INTO buildings (player_id, type, x, y) VALUES ($1, $2, $3, $4)', [id, b.type, b.x, b.y]);
  }
  return id;
}

/**
 * Вход в игру: находит игрока по telegram_id, обновляя имя, язык,
 * часовой пояс и разрешение писать, или создаёт нового. Источник прихода
 * запоминается только первый. Возвращает id игрока.
 */
export async function loginPlayer(db: Db, profile: LoginProfile, now: number = Date.now()): Promise<number> {
  const timezone = profile.timezone && isValidTimezone(profile.timezone) ? profile.timezone : null;
  const source = sourceOf(profile.startParam);
  return inTransaction(db, async (client) => {
    const allows = profile.allowsWriteToPm ?? false;
    let id = await insertPlayer(client, profile, { source, timezone, allowsWriteToPm: allows, canMessage: allows, now });
    if (id === undefined) {
      // Разрешение из initData не отменяет блокировку бота: после 403 ждём /start.
      const updated = await client.query<{ id: number }>(
        `UPDATE players SET
           name = $2, language_code = $3, last_seen_at = $4,
           timezone = COALESCE($5, timezone),
           allows_write_to_pm = COALESCE($6, allows_write_to_pm),
           can_message = can_message OR (COALESCE($6, false) AND bot_blocked_at IS NULL),
           source = COALESCE(source, $7)
         WHERE telegram_id = $1
         RETURNING id`,
        [profile.telegramId, profile.name, profile.languageCode, new Date(now), timezone, profile.allowsWriteToPm ?? null, source],
      );
      id = updated.rows[0]!.id;
    }
    await trackEvent(client, id, 'login', source ? { source } : null, now);
    if (profile.startParam?.startsWith(NOTIFICATION_START_PREFIX)) {
      await trackEvent(client, id, 'notification_open', { type: profile.startParam.slice(NOTIFICATION_START_PREFIX.length) }, now);
    }
    return id;
  });
}

export interface BotUser {
  telegramId: number;
  name: string;
  languageCode: string;
}

/**
 * /start в боте: игрок написал боту сам — значит, бот может ему писать
 * (снимается и блокировка после 403). Новый игрок создаётся сразу, чтобы
 * запомнить источник из параметра /start.
 */
export async function startFromBot(db: Db, user: BotUser, startParam: string | undefined, now: number = Date.now()): Promise<number> {
  const source = sourceOf(startParam);
  return inTransaction(db, async (client) => {
    // Новый игрок из бота ещё не был в игре: last_seen_at — в прошлом.
    let id = await insertPlayer(client, user, { source, timezone: null, allowsWriteToPm: false, canMessage: true, now, lastSeenAt: 0 });
    if (id === undefined) {
      const updated = await client.query<{ id: number }>(
        `UPDATE players SET can_message = true, bot_blocked_at = NULL, language_code = $2, source = COALESCE(source, $3)
         WHERE telegram_id = $1 RETURNING id`,
        [user.telegramId, user.languageCode, source],
      );
      id = updated.rows[0]!.id;
    }
    await trackEvent(client, id, 'bot_start', startParam ? { param: startParam } : null, now);
    // Теперь писать можно — запланировать уведомления об уже идущих стройках.
    await resyncNotifications(client, id, now);
    return id;
  });
}

/** Игрок для команд бота (/settings): находит по telegram_id или создаёт, ничего не меняя у существующего. */
export async function ensureBotPlayer(db: Db, user: BotUser, now: number = Date.now()): Promise<number> {
  return inTransaction(db, async (client) => {
    const found = await client.query<{ id: number }>('SELECT id FROM players WHERE telegram_id = $1', [user.telegramId]);
    if (found.rows[0]) return found.rows[0].id;
    const id = await insertPlayer(client, user, {
      source: null,
      timezone: null,
      allowsWriteToPm: false,
      canMessage: false,
      now,
      lastSeenAt: 0,
    });
    return id ?? (await client.query<{ id: number }>('SELECT id FROM players WHERE telegram_id = $1', [user.telegramId])).rows[0]!.id;
  });
}
