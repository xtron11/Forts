/**
 * Когда можно отправить сообщение игроку: не в игре прямо сейчас, не
 * чаще лимитов, не в тихие часы. Чистые функции от времени.
 */
import { WRITE_ACCESS_REPROMPT_MS, type NotifyTiming } from './timing';

const DAY_MS = 24 * 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  if (timezone.length > 64) return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Смещение местного времени от UTC в момент at, мс. Неизвестный пояс — UTC. */
export function timezoneOffsetMs(timezone: string | null, at: number): number {
  if (!timezone || !isValidTimezone(timezone)) return 0;
  const parts = formatter(timezone).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(at / 1000) * 1000;
}

/** Если at попадает в тихие часы игрока — ближайшее их окончание, иначе at. */
export function afterQuietHours(at: number, timezone: string | null, timing: NotifyTiming): number {
  const offset = timezoneOffsetMs(timezone, at);
  const local = at + offset;
  const hour = new Date(local).getUTCHours();
  const { quietStartHour: start, quietEndHour: end } = timing;
  const quiet = start > end ? hour >= start || hour < end : hour >= start && hour < end;
  if (!quiet) return at;
  let localEnd = Math.floor(local / DAY_MS) * DAY_MS + end * 3_600_000;
  if (localEnd <= local) localEnd += DAY_MS;
  // Смещение берём на момент окончания — на случай перехода на летнее время ночью.
  return localEnd - timezoneOffsetMs(timezone, localEnd - offset);
}

export interface DeliveryInput {
  now: number;
  /** Когда игрок последний раз был в игре. */
  lastSeenAt: number;
  /** Моменты уже отправленных игроку сообщений (хватит последних суток). */
  sentAt: readonly number[];
  timezone: string | null;
}

/**
 * Самый ранний момент ≥ now, когда игроку можно написать: прошло
 * activeWindow с его последнего визита, minInterval с прошлого сообщения,
 * за скользящие сутки меньше dailyLimit сообщений и сейчас не тихие часы.
 */
export function earliestSendTime({ now, lastSeenAt, sentAt, timezone }: DeliveryInput, timing: NotifyTiming): number {
  let at = Math.max(now, lastSeenAt + timing.activeWindowMs);
  const sent = [...sentAt].sort((a, b) => b - a);
  if (sent.length > 0) at = Math.max(at, sent[0]! + timing.minIntervalMs);
  // Сообщения, которые будут в окне суток в момент at; при сдвиге at вперёд их меньше.
  const inWindow = sent.filter((t) => t > at - timing.dayMs);
  if (inWindow.length >= timing.dailyLimit) at = Math.max(at, inWindow[timing.dailyLimit - 1]! + timing.dayMs);
  return afterQuietHours(at, timezone, timing);
}

/**
 * Предлагать ли в игре уведомления: бот не может писать, у игрока есть
 * что-то кроме ратуши (была постройка) и не отказывался последнюю неделю.
 */
export function shouldAskWriteAccess(
  player: { canMessage: boolean; writeAccessAskedAt: number | null },
  buildings: readonly { type: string }[],
  now: number,
): boolean {
  if (player.canMessage) return false;
  if (!buildings.some((b) => b.type !== 'townhall')) return false;
  return player.writeAccessAskedAt === null || now - player.writeAccessAskedAt >= WRITE_ACCESS_REPROMPT_MS;
}
