/**
 * Числа боя: поле, время, зона высадки, оборона, добыча. HP зданий — в
 * balance.ts, войска — в troops.ts.
 */
import type { BuildingType } from '../buildings';
import { TICKS_PER_SECOND, TILE, type TargetGroup } from '../troops';

/** Лимит боя: 3 минуты. */
export const BATTLE_MAX_TICKS = 3 * 60 * TICKS_PER_SECOND;

/**
 * Поле боя шире базы на столько клеток с каждой стороны — там высаживаются
 * войска, даже если база застроена до края.
 */
export const BATTLE_MARGIN = 4;

/** Высаживать нельзя ближе этого числа клеток к любому зданию (включая стены). */
export const DEPLOY_MIN_DISTANCE = 2;

/** Больше юнитов за один бой не высадить. */
export const MAX_DEPLOYMENTS = 200;

/**
 * Путь «сквозь» здание, которое не стена и не цель, стоит столько клеток
 * лишнего хода: юнит пойдёт его ломать, только если иначе цель недостижима.
 */
export const BUILDING_BLOCK_TILES = 100;

export interface DefenseLevel {
  /** Радиус от центра башни до юнита, единицы длины. */
  range: number;
  /** Урон за выстрел. */
  damage: number;
  /** Тиков между выстрелами. */
  attackTicks: number;
}

/** Оборонительная башня по уровням; индекс = уровень − 1. Бьёт ближайший юнит в радиусе. */
// prettier-ignore
export const TOWER_LEVELS: readonly DefenseLevel[] = [
  { range: 6 * TILE,       damage: 30, attackTicks: 10 },
  { range: 6 * TILE,       damage: 38, attackTicks: 10 },
  { range: 6 * TILE + 500, damage: 47, attackTicks: 10 },
  { range: 6 * TILE + 500, damage: 58, attackTicks: 10 },
  { range: 7 * TILE,       damage: 70, attackTicks: 10 },
];

/** К какой группе целей относится здание (см. TroopConfig.targets). */
export const BUILDING_TARGET_GROUP: Readonly<Record<BuildingType, Exclude<TargetGroup, 'any'> | null>> = {
  townhall: null,
  goldmine: null,
  farm: null,
  barracks: null,
  camp: null,
  tower: 'defense',
  wall: 'wall',
};

/**
 * Добыча, %: от ресурсов в хранилище цели (делится поровну между
 * зданиями, кроме стен, и достаётся по мере их разрушения) и от
 * накопленного в каждой разрушенной шахте/ферме.
 */
export const LOOT_STORAGE_PERCENT = 20;
export const LOOT_PRODUCER_PERCENT = 50;

/** Звёзды: за разрушение не меньше этого процента, за ратушу и за 100%. */
export const STAR_DESTRUCTION_PERCENT = 50;

/** Если игрок не прислал итог боя за это время, сервер закрывает бой с теми высадками, что знает. */
export const BATTLE_FINISH_TIMEOUT_SECONDS = 5 * 60;

/** Цена кнопки «Следующая» (другая цель), золото, по уровню ратуши атакующего 1..5. Первый поиск бесплатный. */
export const SEARCH_COST_GOLD: readonly number[] = [10, 25, 50, 100, 200];

/** Цели подбираются с ратушей в пределах ± этого числа уровней. */
export const MATCH_TOWNHALL_RANGE = 1;

export function searchCost(townhallLevel: number): number {
  return SEARCH_COST_GOLD[Math.min(Math.max(townhallLevel, 1), SEARCH_COST_GOLD.length) - 1]!;
}
