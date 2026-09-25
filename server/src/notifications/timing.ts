/**
 * Правила частоты уведомлений. Это не игровой баланс, а защита игрока от
 * спама, поэтому числа живут на сервере, а не в shared.
 */

export const NOTIFICATION_TYPES = ['build_done', 'storage_full', 'army_ready'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export interface NotifyTiming {
  /** Как часто воркер проверяет очередь. */
  workerIntervalMs: number;
  /** Игрок был в игре позже — не пишем, он и так всё видит. */
  activeWindowMs: number;
  /** Минимум между двумя сообщениями одному игроку. */
  minIntervalMs: number;
  /** Не больше dailyLimit сообщений за dayMs. */
  dailyLimit: number;
  dayMs: number;
  /** События, до которых осталось меньше этого, уходят вместе с текущим одним сообщением. */
  mergeWindowMs: number;
  /** Тихие часы по местному времени игрока: с quietStartHour до quietEndHour. */
  quietStartHour: number;
  quietEndHour: number;
  /** Повтор после сетевой/неизвестной ошибки Telegram: retryDelayMs × номер попытки. */
  retryDelayMs: number;
  maxAttempts: number;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

export const NOTIFY_TIMING: NotifyTiming = {
  workerIntervalMs: 30 * SEC,
  activeWindowMs: 2 * MIN,
  minIntervalMs: 30 * MIN,
  dailyLimit: 4,
  dayMs: 24 * HOUR,
  mergeWindowMs: 10 * MIN,
  quietStartHour: 23,
  quietEndHour: 8,
  retryDelayMs: 5 * MIN,
  maxAttempts: 3,
};

/**
 * NOTIFY_TEST_MODE (только development): те же правила, но задержки
 * короткие, чтобы проверить всё вручную за пару минут. Тихие часы
 * остаются как есть.
 */
export const NOTIFY_TEST_TIMING: NotifyTiming = {
  ...NOTIFY_TIMING,
  workerIntervalMs: 5 * SEC,
  activeWindowMs: 15 * SEC,
  minIntervalMs: 1 * MIN,
  dayMs: 15 * MIN,
  mergeWindowMs: 20 * SEC,
  retryDelayMs: 10 * SEC,
};

/** Не предлагать уведомления в игре чаще раза в неделю. */
export const WRITE_ACCESS_REPROMPT_MS = 7 * 24 * HOUR;
