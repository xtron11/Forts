/**
 * Войска и казарма: стоимость, время тренировки, место в армии и боевые
 * характеристики по уровням. Все игровые числа войск — только здесь.
 *
 * Единицы боя: 1 клетка = TILE единиц длины (фиксированная точка),
 * время — тики, TICKS_PER_SECOND в секунду. Характеристики боя целые.
 */

/** Единиц длины в одной клетке поля. */
export const TILE = 1000;

/** Тиков боя в секунду. */
export const TICKS_PER_SECOND = 10;

export const TROOP_TYPES = ['warrior', 'archer', 'ram'] as const;

export type TroopType = (typeof TROOP_TYPES)[number];

export function isTroopType(value: unknown): value is TroopType {
  return typeof value === 'string' && (TROOP_TYPES as readonly string[]).includes(value);
}

/**
 * Какие здания юнит выбирает целью. Группы проверяются по порядку:
 * цель — ближайшее живое здание первой непустой группы.
 */
export type TargetGroup = 'any' | 'defense' | 'wall';

export interface TroopLevel {
  /** Стоимость тренировки одного юнита, еда. */
  food: number;
  trainSeconds: number;
  /** Минимальный уровень казармы для этого уровня войска. */
  barracksLevel: number;
  hp: number;
  /** Урон за удар. */
  damage: number;
  /** Тиков между ударами (скорость атаки). */
  attackTicks: number;
  /** Радиус атаки от юнита до края здания, единицы длины (TILE — клетка). */
  range: number;
  /** Скорость, единицы длины за тик. */
  speed: number;
}

export interface TroopConfig {
  type: TroopType;
  /** Место в армии. */
  housing: number;
  /** Приоритет целей. */
  targets: readonly TargetGroup[];
  /** Урон по стенам, % от обычного. */
  wallDamagePercent: number;
  /**
   * Насколько путь в обход стены может быть длиннее (в клетках), чтобы юнит
   * пошёл в обход, а не стал ломать стену.
   */
  wallDetourTiles: number;
  /** Цвет-заглушка, 0xRRGGBB. */
  color: number;
  levels: readonly TroopLevel[];
}

const S = 1;

type Row = readonly [
  food: number,
  seconds: number,
  barracks: number,
  hp: number,
  damage: number,
  attackTicks: number,
  range: number,
  speed: number,
];

function levels(rows: readonly Row[]): TroopLevel[] {
  return rows.map(([food, trainSeconds, barracksLevel, hp, damage, attackTicks, range, speed]) => ({
    food,
    trainSeconds,
    barracksLevel,
    hp,
    damage,
    attackTicks,
    range,
    speed,
  }));
}

// Уровни — по строкам, индекс строки = уровень − 1.
// Скорость 150 = 1,5 клетки в секунду; радиус 800 = 0,8 клетки (ближний бой).
export const TROOPS: Readonly<Record<TroopType, TroopConfig>> = {
  // Дешёвый, ближний бой, бьёт ближайшее здание.
  warrior: {
    type: 'warrior',
    housing: 1,
    targets: ['any'],
    wallDamagePercent: 100,
    wallDetourTiles: 8,
    color: 0xe67e22,
    // prettier-ignore
    levels: levels([
      [ 50, 10 * S, 1, 120, 12, 10, 800, 150],
      [ 80, 12 * S, 3, 150, 15, 10, 800, 150],
      [120, 15 * S, 4, 185, 19, 10, 800, 160],
    ]),
  },
  // Дальний бой, слабый, бьёт ближайшее здание.
  archer: {
    type: 'archer',
    housing: 1,
    targets: ['any'],
    wallDamagePercent: 100,
    wallDetourTiles: 8,
    color: 0x27ae60,
    // prettier-ignore
    levels: levels([
      [100, 15 * S, 2, 50, 10, 10, 3500, 150],
      [150, 18 * S, 4, 62, 13, 10, 3500, 150],
    ]),
  },
  // Медленный и крепкий: сначала оборона, потом стены; стены ломает, а не обходит.
  ram: {
    type: 'ram',
    housing: 4,
    targets: ['defense', 'wall', 'any'],
    wallDamagePercent: 300,
    wallDetourTiles: 1,
    color: 0x6d4c41,
    // prettier-ignore
    levels: levels([
      [300, 40 * S, 3, 450, 60, 20, 800, 80],
      [450, 50 * S, 4, 560, 80, 20, 800, 80],
    ]),
  },
};

export function troopLevelConfig(type: TroopType, level: number): TroopLevel | undefined {
  return level >= 1 ? TROOPS[type].levels[level - 1] : undefined;
}

/**
 * Уровень войска, который тренирует казарма уровня barracksLevel (лучшая
 * казарма игрока); 0 — войско ещё недоступно.
 */
export function troopLevelFor(type: TroopType, barracksLevel: number): number {
  let level = 0;
  TROOPS[type].levels.forEach((l, i) => {
    if (l.barracksLevel <= barracksLevel) level = i + 1;
  });
  return level;
}

/** Место в армии, которое даёт лагерь по уровням; индекс = уровень − 1. Лагеря складываются. */
export const CAMP_CAPACITY: readonly number[] = [20, 30, 40, 50];

/** Сколько юнитов можно заказать одним запросом тренировки. */
export const MAX_TRAIN_BATCH = 50;
