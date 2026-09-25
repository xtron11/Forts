/**
 * События для статистики удержания (таблица events). Пишутся в той же
 * транзакции, что и само действие.
 */
import type pg from 'pg';

export type EventType =
  /** Вход в игру (мини-приложение или браузер в режиме разработки). */
  | 'login'
  /** Вход по кнопке уведомления: startapp=notif_<тип>. */
  | 'notification_open'
  /** Бот отправил сообщение-уведомление (одно сообщение может объединять несколько событий). */
  | 'notification_sent'
  /** /start в боте. */
  | 'bot_start'
  /** Ответ на предложение уведомлений в игре. */
  | 'write_access';

export async function trackEvent(
  client: pg.PoolClient,
  playerId: number,
  type: EventType,
  data: Record<string, unknown> | null = null,
  at: number = Date.now(),
): Promise<void> {
  await client.query('INSERT INTO events (player_id, type, data, created_at) VALUES ($1, $2, $3, $4)', [playerId, type, data, new Date(at)]);
}
