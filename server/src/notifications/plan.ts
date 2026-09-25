/**
 * Какие уведомления должны существовать для текущего состояния базы.
 * Чистая функция: сервер вызывает её после каждого изменения базы и в
 * воркере перед отправкой, а store.ts приводит таблицу к результату.
 */
import { fillTime, isProducer, PRODUCERS, RESOURCE_TYPES, trainingDoneAt, type PlacedBuilding, type ResourceType, type TrainingItem } from '@forts/shared';
import type { NotificationType } from './timing';

export type NotificationPayload =
  | { buildingId: number; building: PlacedBuilding['type']; level: number }
  | { resource: ResourceType }
  /** Сколько юнитов было в очереди, когда планировали. */
  | { units: number };

export interface PlannedNotification {
  type: NotificationType;
  /** Объект события: id здания или ресурс. Вместе с type и игроком — уникальный ключ. */
  key: string;
  /** Когда событие происходит в игре, мс. */
  eventAt: number;
  payload: NotificationPayload;
}

export interface PlanInput {
  /** Здания как в базе: стройки с прошедшим finishAt ещё не завершены — значит, игрок их не видел. */
  buildings: readonly PlacedBuilding[];
  /** Очередь тренировки (юниты с прошедшим finishAt игрок, как и стройки, ещё не видел). */
  training?: readonly Pick<TrainingItem, 'finishAt'>[];
  /**
   * Когда игрок последний раз был в игре. События до этого момента он уже
   * видел; уведомлять можно только о более поздних.
   */
  since: number;
  /** Может ли бот писать игроку. */
  canMessage: boolean;
  /** Выключенные в /settings типы. */
  disabled: readonly string[];
}

export function planNotifications({ buildings, training = [], since, canMessage, disabled }: PlanInput): PlannedNotification[] {
  if (!canMessage) return [];
  const planned: PlannedNotification[] = [];

  if (!disabled.includes('build_done')) {
    for (const b of buildings) {
      if (b.finishAt === null || b.finishAt <= since) continue;
      planned.push({
        type: 'build_done',
        key: String(b.id),
        eventAt: b.finishAt,
        payload: { buildingId: b.id, building: b.type, level: b.level + 1 },
      });
    }
  }

  // Одно уведомление на ресурс: ближайший момент, когда заполнится
  // какая-нибудь шахта (ферма), которую игрок ещё не видел полной.
  if (!disabled.includes('storage_full')) {
    for (const resource of RESOURCE_TYPES) {
      let first = Infinity;
      for (const b of buildings) {
        if (!isProducer(b.type) || PRODUCERS[b.type].resource !== resource) continue;
        const at = fillTime(b);
        if (at !== undefined && at > since && at < first) first = at;
      }
      if (first !== Infinity) planned.push({ type: 'storage_full', key: resource, eventAt: first, payload: { resource } });
    }
  }

  // Армия готова — когда дотренируется последний юнит очереди.
  if (!disabled.includes('army_ready')) {
    const doneAt = trainingDoneAt(training);
    if (doneAt !== undefined && doneAt > since) {
      const units = training.filter((q) => q.finishAt > since).length;
      planned.push({ type: 'army_ready', key: 'army', eventAt: doneAt, payload: { units } });
    }
  }

  return planned;
}
