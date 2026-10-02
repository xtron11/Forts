/**
 * Правила казармы и армии — чистые функции от состояния и времени now (мс),
 * как экономика: очередь тренировки хранит finishAt каждого юнита, и
 * готовые юниты переходят в армию при первом запросе после finishAt.
 *
 * Очередь одна на игрока, юниты тренируются по одному друг за другом.
 * Место в армии — сумма мест всех готовых лагерей; казарма только тренирует.
 */
import type { BuildingState } from './economy';
import { settleBuilding } from './economy';
import type { Resources } from './resources';
import {
  CAMP_CAPACITY,
  isTroopType,
  MAX_TRAIN_BATCH,
  TROOP_TYPES,
  TROOPS,
  troopLevelConfig,
  troopLevelFor,
  type TroopType,
} from './troops';

/** Готовые юниты одного типа и уровня. */
export interface ArmyStack {
  troop: TroopType;
  level: number;
  count: number;
}

/** Юнит в очереди тренировки. */
export interface TrainingItem {
  id: number;
  troop: TroopType;
  level: number;
  /** Сколько еды списано — столько и вернётся при отмене. */
  food: number;
  /** Длительность тренировки, с. */
  seconds: number;
  /** Когда юнит будет готов, мс. */
  finishAt: number;
}

/** Уровень лучшей готовой казармы; 0 — казарм нет. */
export function barracksLevel(buildings: readonly BuildingState[], now: number): number {
  let level = 0;
  for (const b of buildings) {
    if (b.type === 'barracks') level = Math.max(level, settleBuilding(b, now).level);
  }
  return level;
}

/** Место в армии: сумма по готовым лагерям (улучшающийся считается по текущему уровню). */
export function armyCapacity(buildings: readonly BuildingState[], now: number): number {
  let total = 0;
  for (const b of buildings) {
    if (b.type !== 'camp') continue;
    const level = settleBuilding(b, now).level;
    if (level >= 1) total += CAMP_CAPACITY[Math.min(level, CAMP_CAPACITY.length) - 1]!;
  }
  return total;
}

/** Сколько места занимают готовые юниты и очередь. */
export function usedHousing(army: readonly ArmyStack[], queue: readonly Pick<TrainingItem, 'troop'>[]): number {
  let total = 0;
  for (const s of army) total += TROOPS[s.troop].housing * s.count;
  for (const q of queue) total += TROOPS[q.troop].housing;
  return total;
}

/** Добавляет count юнитов в армию; порядок стеков — как в TROOP_TYPES, затем по уровню. */
export function addToArmy(army: readonly ArmyStack[], troop: TroopType, level: number, count: number): ArmyStack[] {
  const result = army.map((s) => ({ ...s }));
  const stack = result.find((s) => s.troop === troop && s.level === level);
  if (stack) stack.count += count;
  else result.push({ troop, level, count });
  return result
    .filter((s) => s.count > 0)
    .sort((a, b) => TROOP_TYPES.indexOf(a.troop) - TROOP_TYPES.indexOf(b.troop) || a.level - b.level);
}

export interface SettledTraining {
  army: ArmyStack[];
  /** Ещё не готовые, по порядку готовности. */
  queue: TrainingItem[];
  /** Готовые к now — их нужно убрать из очереди. */
  done: TrainingItem[];
}

/** Переводит готовые к now юниты из очереди в армию. */
export function settleTraining(army: readonly ArmyStack[], queue: readonly TrainingItem[], now: number): SettledTraining {
  const sorted = [...queue].sort((a, b) => a.finishAt - b.finishAt || a.id - b.id);
  const done = sorted.filter((q) => q.finishAt <= now);
  let result = army.map((s) => ({ ...s }));
  for (const q of done) result = addToArmy(result, q.troop, q.level, 1);
  return { army: result, queue: sorted.filter((q) => q.finishAt > now), done };
}

/** Когда будет готов весь заказ; undefined — очередь пуста. */
export function trainingDoneAt(queue: readonly Pick<TrainingItem, 'finishAt'>[]): number | undefined {
  let last: number | undefined;
  for (const q of queue) if (last === undefined || q.finishAt > last) last = q.finishAt;
  return last;
}

export type TrainError =
  | 'unknown_troop'
  | 'invalid_count'
  | 'no_barracks'
  | 'no_camp'
  | 'barracks_level_too_low'
  | 'army_full'
  | 'not_enough_resources';

export type TrainCheck =
  | { ok: true; level: number; food: number; seconds: number }
  | {
      ok: false;
      reason: TrainError;
      /** Для barracks_level_too_low: какой уровень казармы нужен. */
      requiredBarracks?: number;
      /** Для army_full: сколько места свободно. */
      free?: number;
    };

/**
 * Можно ли заказать count юнитов troop: есть казарма нужного уровня, лагерь,
 * хватает места (с учётом очереди) и еды. Юниты тренируются на уровне,
 * который даёт лучшая казарма.
 */
export function checkTrain(
  resources: Resources,
  buildings: readonly BuildingState[],
  army: readonly ArmyStack[],
  queue: readonly TrainingItem[],
  troop: string,
  count: number,
  now: number,
): TrainCheck {
  if (!isTroopType(troop)) return { ok: false, reason: 'unknown_troop' };
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRAIN_BATCH) return { ok: false, reason: 'invalid_count' };
  const bLevel = barracksLevel(buildings, now);
  if (bLevel < 1) return { ok: false, reason: 'no_barracks' };
  const level = troopLevelFor(troop, bLevel);
  if (level < 1) return { ok: false, reason: 'barracks_level_too_low', requiredBarracks: TROOPS[troop].levels[0]!.barracksLevel };
  const capacity = armyCapacity(buildings, now);
  if (capacity === 0) return { ok: false, reason: 'no_camp' };
  const free = capacity - usedHousing(army, queue);
  if (TROOPS[troop].housing * count > free) return { ok: false, reason: 'army_full', free: Math.max(0, free) };
  const cfg = troopLevelConfig(troop, level)!;
  if (resources.food < cfg.food * count) return { ok: false, reason: 'not_enough_resources' };
  return { ok: true, level, food: cfg.food, seconds: cfg.trainSeconds };
}

/**
 * Моменты готовности count новых юнитов: сразу за последним в очереди
 * (или от now, если очередь пуста), по одному.
 */
export function scheduleTraining(queue: readonly Pick<TrainingItem, 'finishAt'>[], seconds: number, count: number, now: number): number[] {
  let at = Math.max(now, trainingDoneAt(queue) ?? now);
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    at += seconds * 1000;
    result.push(at);
  }
  return result;
}

export interface CancelResult {
  /** Оставшаяся очередь с пересчитанными finishAt. */
  queue: TrainingItem[];
  refund: number;
}

/**
 * Убирает юнит id из очереди и возвращает его еду. Следующие за ним
 * юниты сдвигаются раньше на столько, сколько ему оставалось.
 * undefined — такого юнита в очереди нет (или он уже готов).
 */
export function cancelTraining(queue: readonly TrainingItem[], id: number, now: number): CancelResult | undefined {
  const item = queue.find((q) => q.id === id);
  if (!item || item.finishAt <= now) return undefined;
  const shift = Math.min(item.seconds * 1000, item.finishAt - now);
  const rest = queue
    .filter((q) => q.id !== id)
    .map((q) => (q.finishAt > item.finishAt ? { ...q, finishAt: q.finishAt - shift } : q));
  return { queue: rest, refund: item.food };
}
