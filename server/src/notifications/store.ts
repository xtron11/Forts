/**
 * Таблица notifications как отражение плана (plan.ts). Строка одна на
 * (игрок, тип, объект) и переиспользуется: новый момент события — снова
 * pending; то же событие, уже отправленное, — не трогаем (дедупликация);
 * событие пропало из плана — pending становится cancelled.
 */
import type pg from 'pg';
import { loadBuildings, loadTraining } from '../rows';
import { planNotifications, type NotificationPayload, type PlannedNotification } from './plan';

export type NotificationStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export interface NotificationRow {
  id: number;
  type: string;
  key: string;
  event_at: Date;
  send_at: Date;
  payload: NotificationPayload;
  status: NotificationStatus;
  attempts: number;
}

export const NOTIFICATION_COLUMNS = 'id, type, key, event_at, send_at, payload, status, attempts';

export interface NotificationDiff {
  insert: PlannedNotification[];
  /** Существующие строки, которые снова ждут отправки с новым событием. */
  reset: { id: number; planned: PlannedNotification }[];
  cancel: number[];
}

/** Что поменять в таблице, чтобы она соответствовала плану. */
export function diffNotifications(existing: readonly NotificationRow[], planned: readonly PlannedNotification[]): NotificationDiff {
  const diff: NotificationDiff = { insert: [], reset: [], cancel: [] };
  const byKey = new Map(existing.map((row) => [`${row.type}:${row.key}`, row]));
  const plannedKeys = new Set<string>();

  for (const p of planned) {
    const k = `${p.type}:${p.key}`;
    plannedKeys.add(k);
    const row = byKey.get(k);
    if (!row) {
      diff.insert.push(p);
      continue;
    }
    const sameEvent = row.event_at.getTime() === p.eventAt;
    // То же событие ждёт отправки (send_at мог быть отложен — не сбрасываем), уже
    // отправлено или окончательно не отправилось — не трогаем. Отменённое
    // (например, тип выключали в /settings) снова ждёт отправки.
    if (sameEvent && row.status !== 'cancelled') continue;
    diff.reset.push({ id: row.id, planned: p });
  }

  for (const row of existing) {
    if (row.status === 'pending' && !plannedKeys.has(`${row.type}:${row.key}`)) diff.cancel.push(row.id);
  }
  return diff;
}

/**
 * Приводит уведомления игрока к плану. Вызывать при заблокированной строке
 * игрока (как в игровых действиях и воркере) — тогда параллельных
 * пересчётов одного игрока нет.
 */
export async function syncNotifications(
  client: pg.PoolClient,
  playerId: number,
  planned: readonly PlannedNotification[],
  now: number,
): Promise<void> {
  const { rows } = await client.query<NotificationRow>(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE player_id = $1`, [playerId]);
  const diff = diffNotifications(rows, planned);
  const at = new Date(now);

  for (const p of diff.insert) {
    await client.query(
      `INSERT INTO notifications (player_id, type, key, event_at, send_at, payload, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6)
       ON CONFLICT (player_id, type, key) DO NOTHING`,
      [playerId, p.type, p.key, new Date(p.eventAt), p.payload, at],
    );
  }
  for (const { id, planned: p } of diff.reset) {
    await client.query(
      `UPDATE notifications
       SET event_at = $2, send_at = $2, payload = $3, status = 'pending', attempts = 0, sent_at = NULL, updated_at = $4
       WHERE id = $1`,
      [id, new Date(p.eventAt), p.payload, at],
    );
  }
  if (diff.cancel.length > 0) {
    await client.query(`UPDATE notifications SET status = 'cancelled', updated_at = $2 WHERE id = ANY($1)`, [diff.cancel, at]);
  }
}

interface PlayerNotifyRow {
  telegram_id: number;
  can_message: boolean;
  notifications_off: string[];
  last_seen_at: Date;
}

/** Может ли бот писать: разрешено и это настоящий Telegram-игрок (у тестовых id < 0). */
export function botCanMessage(row: { telegram_id: number; can_message: boolean }): boolean {
  return row.can_message && row.telegram_id > 0;
}

/**
 * Пересчитывает уведомления по тому, что сейчас в базе, считая, что игрок
 * видел базу в last_seen_at. Для изменений не из игры: /start, /settings,
 * воркер перед отправкой.
 */
export async function resyncNotifications(client: pg.PoolClient, playerId: number, now: number): Promise<void> {
  const { rows } = await client.query<PlayerNotifyRow>(
    'SELECT telegram_id, can_message, notifications_off, last_seen_at FROM players WHERE id = $1',
    [playerId],
  );
  const player = rows[0];
  if (!player) return;
  const buildings = await loadBuildings(client, playerId);
  const training = await loadTraining(client, playerId);
  const planned = planNotifications({
    buildings,
    training,
    since: player.last_seen_at.getTime(),
    canMessage: botCanMessage(player),
    disabled: player.notifications_off,
  });
  await syncNotifications(client, playerId, planned, now);
}
