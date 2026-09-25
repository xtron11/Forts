/**
 * Воркер очереди уведомлений — в том же процессе, что и API. Раз в
 * workerIntervalMs забирает игроков с созревшими уведомлениями и для
 * каждого в отдельной транзакции:
 *   1. блокирует строку игрока (FOR UPDATE SKIP LOCKED): другой экземпляр
 *      сервера или идущий игровой запрос — пропускаем, возьмём на следующем
 *      круге. Порядок блокировок тот же, что в игровых запросах (сначала
 *      игрок, потом уведомления), поэтому взаимных блокировок нет;
 *   2. пересчитывает план по текущей базе — неактуальное отменяется
 *      (игрок собрал ресурсы, заходил после события);
 *   3. проверяет правила частоты (policy.ts) — если рано, переносит send_at;
 *   4. отправляет одно сообщение со всеми событиями в пределах mergeWindow.
 */
import type pg from 'pg';
import { inTransaction, type Db } from '../db';
import { trackEvent } from '../events';
import { localeFor, t } from '../i18n';
import { composeNotification, notificationStartParam, type NotificationItem } from './messages';
import { earliestSendTime } from './policy';
import type { NotificationSender } from './sender';
import { botCanMessage, NOTIFICATION_COLUMNS, resyncNotifications, type NotificationRow } from './store';
import { isNotificationType, type NotifyTiming } from './timing';

export interface WorkerDeps {
  db: Db;
  sender: NotificationSender;
  timing: NotifyTiming;
  /** Адрес мини-приложения для кнопки; без него сообщение без кнопки. */
  webappUrl?: string;
  now?: () => number;
  log?: { info(msg: string): void; warn(msg: string): void; error(obj: unknown, msg?: string): void };
}

export interface TickResult {
  sent: number;
  deferred: number;
  /** Telegram попросил подождать (429) — до этого момента ничего не отправляем. */
  pauseUntil?: number;
}

interface PlayerRow {
  telegram_id: number;
  language_code: string;
  last_seen_at: Date;
  timezone: string | null;
  can_message: boolean;
  notify_counter: number;
}

const PLAYERS_PER_TICK = 100;

type PlayerOutcome = 'sent' | 'deferred' | 'skipped' | { pauseUntil: number };

async function processPlayer(client: pg.PoolClient, playerId: number, deps: WorkerDeps, now: number): Promise<PlayerOutcome> {
  const { timing } = deps;
  const locked = await client.query<PlayerRow>(
    `SELECT telegram_id, language_code, last_seen_at, timezone, can_message, notify_counter
     FROM players WHERE id = $1 FOR UPDATE SKIP LOCKED`,
    [playerId],
  );
  const player = locked.rows[0];
  if (!player) return 'skipped';

  // Пересчёт по текущей базе: если бот не может писать или тип выключен, план пуст и всё отменится.
  await resyncNotifications(client, playerId, now);
  if (!botCanMessage(player)) return 'skipped';

  const { rows } = await client.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE player_id = $1 AND status = 'pending' ORDER BY event_at FOR UPDATE`,
    [playerId],
  );
  const due = rows.filter((r) => r.send_at.getTime() <= now);
  if (due.length === 0) return 'skipped';

  const sent = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM events WHERE player_id = $1 AND type = 'notification_sent' AND created_at > $2`,
    [playerId, new Date(now - timing.dayMs)],
  );
  const sendAt = earliestSendTime(
    { now, lastSeenAt: player.last_seen_at.getTime(), sentAt: sent.rows.map((r) => r.created_at.getTime()), timezone: player.timezone },
    timing,
  );
  if (sendAt > now) {
    await deferRows(client, due, sendAt, now);
    return 'deferred';
  }

  // Близкие события — одним сообщением.
  const batch = rows.filter((r) => r.send_at.getTime() <= now + timing.mergeWindowMs && isNotificationType(r.type));
  const items: NotificationItem[] = batch.map((r) => ({ type: r.type as NotificationItem['type'], payload: r.payload }));
  const locale = localeFor(player.language_code);
  const text = composeNotification(locale, items, player.notify_counter);
  const button = deps.webappUrl
    ? { text: t(locale, 'bot.open'), url: `${deps.webappUrl}?startapp=${notificationStartParam(items)}` }
    : undefined;
  const ids = batch.map((r) => r.id);
  const result = await deps.sender.send(player.telegram_id, text, button);

  if (result.ok) {
    await client.query(`UPDATE notifications SET status = 'sent', sent_at = $2, updated_at = $2 WHERE id = ANY($1)`, [ids, new Date(now)]);
    await client.query('UPDATE players SET notify_counter = notify_counter + 1 WHERE id = $1', [playerId]);
    await trackEvent(client, playerId, 'notification_sent', { types: items.map((i) => i.type) }, now);
    return 'sent';
  }
  if (result.kind === 'blocked') {
    // Не пытаемся снова до следующего /start.
    await client.query('UPDATE players SET can_message = false, bot_blocked_at = $2 WHERE id = $1', [playerId, new Date(now)]);
    await client.query(`UPDATE notifications SET status = 'failed', updated_at = $2 WHERE player_id = $1 AND status = 'pending'`, [
      playerId,
      new Date(now),
    ]);
    deps.log?.info(`notifications: player ${playerId} blocked the bot (${result.message})`);
    return 'skipped';
  }
  if (result.kind === 'rate_limited') {
    const until = now + result.retryAfterSec * 1000;
    await deferRows(client, batch, until, now);
    return { pauseUntil: until };
  }
  // Прочие ошибки: несколько попыток с растущей паузой, потом failed.
  deps.log?.warn(`notifications: send to player ${playerId} failed: ${result.message}`);
  for (const row of batch) {
    const attempts = row.attempts + 1;
    await client.query(
      `UPDATE notifications SET attempts = $2, status = $3, send_at = $4, updated_at = $5 WHERE id = $1`,
      [row.id, attempts, attempts >= timing.maxAttempts ? 'failed' : 'pending', new Date(now + timing.retryDelayMs * attempts), new Date(now)],
    );
  }
  return 'skipped';
}

async function deferRows(client: pg.PoolClient, rows: readonly NotificationRow[], until: number, now: number): Promise<void> {
  await client.query(`UPDATE notifications SET send_at = $2, updated_at = $3 WHERE id = ANY($1) AND send_at < $2`, [
    rows.map((r) => r.id),
    new Date(until),
    new Date(now),
  ]);
}

/** Один проход по очереди. */
export async function processDueNotifications(deps: WorkerDeps): Promise<TickResult> {
  const now = (deps.now ?? Date.now)();
  const result: TickResult = { sent: 0, deferred: 0 };
  const candidates = await deps.db.query<{ player_id: number }>(
    `SELECT DISTINCT player_id FROM notifications WHERE status = 'pending' AND send_at <= $1 LIMIT ${PLAYERS_PER_TICK}`,
    [new Date(now)],
  );
  for (const { player_id: playerId } of candidates.rows) {
    const outcome = await inTransaction(deps.db, (client) => processPlayer(client, playerId, deps, now));
    if (outcome === 'sent') result.sent++;
    else if (outcome === 'deferred') result.deferred++;
    else if (typeof outcome === 'object') {
      result.pauseUntil = outcome.pauseUntil;
      break;
    }
  }
  return result;
}

/** Запускает воркер; возвращает функцию остановки. */
export function startNotificationWorker(deps: WorkerDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pauseUntil = 0;
  const now = deps.now ?? Date.now;

  const tick = async () => {
    if (stopped) return;
    try {
      if (now() >= pauseUntil) {
        const res = await processDueNotifications(deps);
        if (res.pauseUntil) {
          pauseUntil = res.pauseUntil;
          deps.log?.warn(`notifications: Telegram rate limit, paused until ${new Date(pauseUntil).toISOString()}`);
        }
        if (res.sent || res.deferred) deps.log?.info(`notifications: sent ${res.sent}, deferred ${res.deferred}`);
      }
    } catch (err) {
      deps.log?.error(err, 'notifications: worker tick failed');
    }
    if (!stopped) timer = setTimeout(() => void tick(), deps.timing.workerIntervalMs);
  };
  timer = setTimeout(() => void tick(), 1000);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
