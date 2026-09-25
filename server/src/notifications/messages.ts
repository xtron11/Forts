/**
 * Текст сообщения-уведомления. Одно событие — одна из вариативных фраз;
 * несколько близких событий — одно сообщение со списком.
 */
import { NOTIFICATION_START_PREFIX } from '@forts/shared';
import { t, type Locale } from '../i18n';
import type { NotificationPayload } from './plan';
import type { NotificationType } from './timing';

export interface NotificationItem {
  type: NotificationType;
  payload: NotificationPayload;
}

function phrase(locale: Locale, item: NotificationItem, variant: number, line: boolean): string {
  const p = item.payload;
  if ('resource' in p) return t(locale, line ? `notif.line.full.${p.resource}` : `notif.full.${p.resource}`, undefined, variant);
  const params = { building: t(locale, `building.${p.building}`), level: p.level };
  if (p.level <= 1) return t(locale, line ? 'notif.line.built' : 'notif.built', params, variant);
  return t(locale, line ? 'notif.line.upgraded' : 'notif.upgraded', params, variant);
}

/** variant — номер сообщения игроку: фразы чередуются. */
export function composeNotification(locale: Locale, items: readonly NotificationItem[], variant: number): string {
  if (items.length === 1) return phrase(locale, items[0]!, variant, false);
  return [t(locale, 'notif.digest', undefined, variant), ...items.map((item) => `• ${phrase(locale, item, variant, true)}`)].join('\n');
}

/** Параметр startapp кнопки: по нему видно, по какому уведомлению вошёл игрок. */
export function notificationStartParam(items: readonly NotificationItem[]): string {
  const types = new Set(items.map((i) => i.type));
  return NOTIFICATION_START_PREFIX + (types.size === 1 ? items[0]!.type : 'digest');
}
