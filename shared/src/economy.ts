/**
 * Правила экономики — чистые функции от состояния базы и текущего времени
 * now (мс). Сервер по ним решает и сохраняет, клиент — показывает то же
 * самое. Фоновых таймеров нет: всё, что «накопилось» или «достроилось»,
 * вычисляется в момент запроса.
 */
import {
  BUILDER_COUNT,
  COLLECT_HINT_RATIO,
  levelConfig,
  producerLevel,
  townhallConfig,
  type BuildingLevel,
} from './balance';
import type { PlacedBuilding } from './base';
import { isBuildingType, type BuildingType } from './buildings';
import { RESOURCE_TYPES, type Resources, type ResourceType } from './resources';

const HOUR_MS = 3_600_000;

/** Поля здания, от которых зависят правила экономики. */
export type BuildingState = Pick<PlacedBuilding, 'type' | 'level' | 'finishAt' | 'collectedAt' | 'stored'>;

/** Идёт ли стройка или улучшение в момент now. */
export function isUnderConstruction(b: BuildingState, now: number): boolean {
  return b.finishAt !== null && b.finishAt > now;
}

/**
 * Завершает стройку, если наступил finishAt: уровень +1, добыча
 * продолжается с момента finishAt. Если менять нечего, возвращает тот же объект.
 */
export function settleBuilding<T extends BuildingState>(b: T, now: number): T {
  if (b.finishAt === null || b.finishAt > now) return b;
  return { ...b, level: b.level + 1, finishAt: null, collectedAt: b.finishAt };
}

/** Сколько ресурса лежит в шахте/ферме в момент now: min(stored + добыча × время, вместимость). */
export function accumulated(building: BuildingState, now: number): number {
  const b = settleBuilding(building, now);
  const prod = producerLevel(b.type, b.level);
  if (!prod) return 0;
  // Пока идёт улучшение, добыча стоит.
  if (b.finishAt !== null) return Math.min(b.stored, prod.capacity);
  const elapsed = Math.max(0, now - b.collectedAt);
  return Math.min(prod.capacity, Math.floor(b.stored + (prod.perHour * elapsed) / HOUR_MS));
}

/** Пора ли показывать значок сбора над зданием. */
export function isCollectReady(b: BuildingState, now: number): boolean {
  const prod = producerLevel(b.type, settleBuilding(b, now).level);
  if (!prod) return false;
  return accumulated(b, now) >= Math.max(1, Math.ceil(prod.capacity * COLLECT_HINT_RATIO));
}

/** Уровень ратуши (готовый, без учёта идущего улучшения); 0, если ратуши нет. */
export function townhallLevel(buildings: readonly BuildingState[], now: number): number {
  let level = 0;
  for (const b of buildings) {
    if (b.type === 'townhall') level = Math.max(level, settleBuilding(b, now).level);
  }
  return level;
}

/** Вместимость хранилища игрока — задаёт ратуша. */
export function storageCapacity(buildings: readonly BuildingState[], now: number): Resources {
  const cfg = townhallConfig(townhallLevel(buildings, now));
  return cfg ? { ...cfg.storage } : { gold: 0, food: 0 };
}

/** Сколько ещё поместится в хранилище. */
export function freeStorage(resources: Resources, buildings: readonly BuildingState[], now: number): Resources {
  const cap = storageCapacity(buildings, now);
  return { gold: Math.max(0, cap.gold - resources.gold), food: Math.max(0, cap.food - resources.food) };
}

/** Сколько строителей заняты в момент now. */
export function busyBuilders(buildings: readonly BuildingState[], now: number): number {
  return buildings.filter((b) => isUnderConstruction(b, now)).length;
}

/** Сколько зданий типа type можно иметь при ратуше уровня thLevel. */
export function buildingLimit(type: BuildingType, thLevel: number): number {
  return townhallConfig(thLevel)?.limits[type] ?? 0;
}

/** Первый уровень ратуши, на котором разрешено хотя бы count + 1 зданий типа type; undefined — никогда. */
export function townhallLevelForCount(type: BuildingType, count: number): number | undefined {
  for (let th = 1; townhallConfig(th); th++) {
    if (buildingLimit(type, th) > count) return th;
  }
  return undefined;
}

export function canAfford(resources: Resources, cost: Resources): boolean {
  return RESOURCE_TYPES.every((r) => resources[r] >= cost[r]);
}

export function subtractCost(resources: Resources, cost: Resources): Resources {
  return { gold: resources.gold - cost.gold, food: resources.food - cost.food };
}

export type RuleError =
  | 'unknown_building_type'
  | 'townhall_level_too_low'
  | 'limit_reached'
  | 'no_free_builder'
  | 'not_enough_resources'
  | 'under_construction'
  | 'max_level';

export type RuleCheck =
  | { ok: true; level: BuildingLevel }
  | {
      ok: false;
      reason: RuleError;
      /** Для townhall_level_too_low и limit_reached: какой уровень ратуши нужен (если достижим). */
      requiredTownhall?: number;
      /** Для not_enough_resources: чего не хватает. */
      missing?: ResourceType;
      /** Для limit_reached: сколько можно сейчас. */
      limit?: number;
    };

/** Общие для постройки и улучшения проверки: строитель и ресурсы. */
function checkCostAndBuilder(level: BuildingLevel, resources: Resources, buildings: readonly BuildingState[], now: number): RuleCheck {
  if (level.buildSeconds > 0 && busyBuilders(buildings, now) >= BUILDER_COUNT) return { ok: false, reason: 'no_free_builder' };
  const missing = RESOURCE_TYPES.find((r) => resources[r] < level.cost[r]);
  if (missing) return { ok: false, reason: 'not_enough_resources', missing };
  return { ok: true, level };
}

/**
 * Можно ли начать постройку нового здания type: позволяет ратуша, не
 * превышен лимит, есть свободный строитель и хватает ресурсов. Место
 * проверяет checkPlacement.
 */
export function checkBuild(resources: Resources, buildings: readonly BuildingState[], type: string, now: number): RuleCheck {
  if (!isBuildingType(type)) return { ok: false, reason: 'unknown_building_type' };
  const first = levelConfig(type, 1)!;
  const th = townhallLevel(buildings, now);
  if (first.townhallLevel > th) return { ok: false, reason: 'townhall_level_too_low', requiredTownhall: first.townhallLevel };
  const count = buildings.filter((b) => b.type === type).length;
  const limit = buildingLimit(type, th);
  if (count >= limit) {
    return { ok: false, reason: 'limit_reached', limit, requiredTownhall: townhallLevelForCount(type, count) };
  }
  return checkCostAndBuilder(first, resources, buildings, now);
}

/** Можно ли начать улучшение здания до следующего уровня. */
export function checkUpgrade(resources: Resources, buildings: readonly BuildingState[], building: BuildingState, now: number): RuleCheck {
  if (isUnderConstruction(building, now)) return { ok: false, reason: 'under_construction' };
  const current = settleBuilding(building, now);
  const next = levelConfig(current.type, current.level + 1);
  if (!next) return { ok: false, reason: 'max_level' };
  if (next.townhallLevel > townhallLevel(buildings, now)) {
    return { ok: false, reason: 'townhall_level_too_low', requiredTownhall: next.townhallLevel };
  }
  return checkCostAndBuilder(next, resources, buildings, now);
}

/** Состояние нового здания: сразу готово (стены) или строится до now + время уровня 1. */
export function newBuildingState(type: BuildingType, now: number): Omit<BuildingState, 'type'> {
  const { buildSeconds } = levelConfig(type, 1)!;
  return buildSeconds > 0
    ? { level: 0, finishAt: now + buildSeconds * 1000, collectedAt: now, stored: 0 }
    : { level: 1, finishAt: null, collectedAt: now, stored: 0 };
}

/**
 * Начинает улучшение (проверки — в checkUpgrade). Накопленное к now
 * остаётся в здании и не растёт, пока идёт улучшение.
 */
export function startUpgrade<T extends BuildingState>(building: T, now: number): T {
  const b = settleBuilding(building, now);
  const next = levelConfig(b.type, b.level + 1);
  if (!next) throw new Error(`${b.type} is already at max level`);
  const stored = accumulated(b, now);
  return next.buildSeconds > 0
    ? { ...b, finishAt: now + next.buildSeconds * 1000, collectedAt: now, stored }
    : { ...b, level: b.level + 1, finishAt: null, collectedAt: now, stored };
}

export interface CollectResult<T> {
  building: T;
  resource: ResourceType;
  /** Сколько перешло в хранилище игрока. */
  amount: number;
}

/**
 * Забирает из шахты/фермы в хранилище, но не больше свободного места.
 * Остаток остаётся в здании. undefined — здание ничего не добывает.
 */
export function collect<T extends BuildingState>(
  building: T,
  resources: Resources,
  buildings: readonly BuildingState[],
  now: number,
): CollectResult<T> | undefined {
  const b = settleBuilding(building, now);
  const prod = producerLevel(b.type, b.level);
  if (!prod) return undefined;
  const available = accumulated(b, now);
  const amount = Math.min(available, freeStorage(resources, buildings, now)[prod.resource]);
  // Ничего не забрали — ничего не меняем, чтобы не терять дробную часть добычи.
  if (amount === 0) return { building: b, resource: prod.resource, amount };
  const collectedAt = b.finishAt === null ? now : b.collectedAt;
  return { building: { ...b, stored: available - amount, collectedAt }, resource: prod.resource, amount };
}

/**
 * Когда шахта/ферма заполнится до вместимости (мс), если её не трогать:
 * идущая стройка сначала завершится, затем добыча пойдёт по новому уровню.
 * Уже полная — момент, с которого она полная (не позже collectedAt).
 * undefined — здание ничего не добывает.
 */
export function fillTime(building: BuildingState): number | undefined {
  const b = building.finishAt === null ? building : settleBuilding(building, building.finishAt);
  const prod = producerLevel(b.type, b.level);
  if (!prod || prod.perHour <= 0) return undefined;
  if (b.stored >= prod.capacity) return b.collectedAt;
  // accumulated() округляет вниз, поэтому ищем первый момент, когда stored + добыча ≥ вместимости.
  return b.collectedAt + Math.ceil(((prod.capacity - b.stored) * HOUR_MS) / prod.perHour);
}
