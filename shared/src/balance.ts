/**
 * Баланс экономики: стоимость, время, требования и характеристики зданий
 * по уровням. Все игровые числа экономики — только здесь.
 *
 * Темп: первые постройки — секунды, улучшения — минуты, ратуша 5-го
 * уровня и старшие уровни зданий — часы.
 */
import type { BuildingType } from './buildings';
import type { Resources, ResourceType } from './resources';

export interface BuildingLevel {
  /** Стоимость постройки (для уровня 1) или улучшения до этого уровня. */
  cost: Resources;
  /** Длительность постройки/улучшения в секундах; 0 — мгновенно и без строителя. */
  buildSeconds: number;
  /** Минимальный уровень ратуши для постройки/улучшения до этого уровня. */
  townhallLevel: number;
  hp: number;
}

export interface ProducerLevel extends BuildingLevel {
  /** Добыча в час. */
  perHour: number;
  /** Сколько помещается в самом здании до сбора. */
  capacity: number;
}

export interface TownhallLevel extends BuildingLevel {
  /** Хранилище игрока: больше этого ресурсов не накопить. */
  storage: Resources;
  /** Сколько зданий каждого типа можно иметь на этом уровне ратуши. */
  limits: Readonly<Record<BuildingType, number>>;
}

export type ProducerType = 'goldmine' | 'farm';

export interface ProducerConfig {
  resource: ResourceType;
  levels: readonly ProducerLevel[];
}

/** Сколько построек/улучшений могут идти одновременно. */
export const BUILDER_COUNT = 2;

/** Значок сбора над шахтой/фермой появляется с этой доли её вместимости. */
export const COLLECT_HINT_RATIO = 0.05;

const S = 1;
const M = 60;
const H = 3600;

function cost(gold: number, food: number): Resources {
  return { gold, food };
}

// Уровни — по строкам, индекс строки = уровень − 1.

// prettier-ignore
const PRODUCER_ROWS: readonly [cost: number, seconds: number, townhall: number, hp: number, perHour: number, capacity: number][] = [
  [   150, 10 * S, 1, 400,  300,   500],
  [   300,  1 * M, 1, 450,  500,  1200],
  [   700,  5 * M, 2, 500,  800,  2500],
  [  1500, 20 * M, 3, 560, 1200,  5000],
  [  4000,  1 * H, 4, 620, 1800,  8000],
  [ 10000,  3 * H, 5, 700, 2500, 12000],
];

/** Шахта строится за еду, ферма — за золото: одна кормит другую. */
function producer(resource: ResourceType, paidWith: ResourceType): ProducerConfig {
  return {
    resource,
    levels: PRODUCER_ROWS.map(([price, buildSeconds, townhallLevel, hp, perHour, capacity]) => ({
      cost: paidWith === 'gold' ? cost(price, 0) : cost(0, price),
      buildSeconds,
      townhallLevel,
      hp,
      perHour,
      capacity,
    })),
  };
}

export const PRODUCERS: Readonly<Record<ProducerType, ProducerConfig>> = {
  goldmine: producer('gold', 'food'),
  farm: producer('food', 'gold'),
};

// Лимиты зданий по уровням ратуши 1..5.
// prettier-ignore
const TOWNHALL_LIMITS: Readonly<Record<BuildingType, readonly number[]>> = {
  townhall: [1, 1,  1,  1,  1],
  goldmine: [2, 3,  4,  5,  6],
  farm:     [2, 3,  4,  5,  6],
  barracks: [1, 1,  2,  2,  3],
  camp:     [1, 1,  2,  2,  3],
  tower:    [0, 1,  2,  3,  4],
  wall:     [0, 8, 16, 24, 32],
};

// prettier-ignore
const TOWNHALL_ROWS: readonly [gold: number, seconds: number, townhall: number, hp: number, storage: number][] = [
  [     0,      0, 0, 1500,   2000],
  [  1000,  2 * M, 1, 2000,   5000],
  [  4000, 15 * M, 2, 2600,  15000],
  [ 12000,  1 * H, 3, 3300,  40000],
  [ 35000,  4 * H, 4, 4200, 100000],
];

export const TOWNHALL_LEVELS: readonly TownhallLevel[] = TOWNHALL_ROWS.map(([gold, buildSeconds, townhallLevel, hp, storage], i) => ({
  cost: cost(gold, 0),
  buildSeconds,
  townhallLevel,
  hp,
  storage: { gold: storage, food: storage },
  limits: {
    townhall: TOWNHALL_LIMITS.townhall[i]!,
    goldmine: TOWNHALL_LIMITS.goldmine[i]!,
    farm: TOWNHALL_LIMITS.farm[i]!,
    barracks: TOWNHALL_LIMITS.barracks[i]!,
    camp: TOWNHALL_LIMITS.camp[i]!,
    tower: TOWNHALL_LIMITS.tower[i]!,
    wall: TOWNHALL_LIMITS.wall[i]!,
  },
}));

type Row = readonly [gold: number, food: number, seconds: number, townhall: number, hp: number];

function levels(rows: readonly Row[]): BuildingLevel[] {
  return rows.map(([gold, food, buildSeconds, townhallLevel, hp]) => ({ cost: cost(gold, food), buildSeconds, townhallLevel, hp }));
}

/** Все уровни всех зданий; индекс = уровень − 1. */
export const BUILDING_LEVELS: Readonly<Record<BuildingType, readonly BuildingLevel[]>> = {
  townhall: TOWNHALL_LEVELS,
  goldmine: PRODUCERS.goldmine.levels,
  farm: PRODUCERS.farm.levels,
  // prettier-ignore
  barracks: levels([
    [0,   200, 20 * S, 1, 500],
    [0,  1500,  5 * M, 2, 600],
    [0,  6000, 30 * M, 3, 700],
    [0, 20000,  2 * H, 4, 800],
  ]),
  // Место в армии по уровням — CAMP_CAPACITY в troops.ts.
  // prettier-ignore
  camp: levels([
    [0,   250, 30 * S, 1, 400],
    [0,  2000, 10 * M, 2, 450],
    [0,  7000, 40 * M, 3, 500],
    [0, 22000,  2 * H, 4, 560],
  ]),
  // prettier-ignore
  tower: levels([
    [  500, 0,  1 * M, 2,  600],
    [ 1500, 0, 10 * M, 2,  700],
    [ 5000, 0, 40 * M, 3,  820],
    [15000, 0,  2 * H, 4,  950],
    [30000, 0,  4 * H, 5, 1100],
  ]),
  // Стены ставятся мгновенно и не занимают строителя.
  // prettier-ignore
  wall: levels([
    [  50, 0, 0, 2,  300],
    [ 250, 0, 0, 3,  500],
    [1000, 0, 0, 4,  800],
    [3000, 0, 0, 5, 1200],
  ]),
};

export function maxLevel(type: BuildingType): number {
  return BUILDING_LEVELS[type].length;
}

/** Конфиг уровня level (1..max); undefined вне диапазона. */
export function levelConfig(type: BuildingType, level: number): BuildingLevel | undefined {
  return level >= 1 ? BUILDING_LEVELS[type][level - 1] : undefined;
}

export function isProducer(type: BuildingType): type is ProducerType {
  return Object.hasOwn(PRODUCERS, type);
}

/** Добыча здания на уровне level; undefined, если здание не добывает или уровень вне диапазона. */
export function producerLevel(type: BuildingType, level: number): (ProducerLevel & { resource: ResourceType }) | undefined {
  if (!isProducer(type) || level < 1) return undefined;
  const { resource, levels: all } = PRODUCERS[type];
  const cfg = all[level - 1];
  return cfg && { ...cfg, resource };
}

export function townhallConfig(level: number): TownhallLevel | undefined {
  return level >= 1 ? TOWNHALL_LEVELS[level - 1] : undefined;
}

export const MAX_TOWNHALL_LEVEL = TOWNHALL_LEVELS.length;
