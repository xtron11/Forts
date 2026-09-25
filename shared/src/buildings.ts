/**
 * Типы зданий и их неизменные свойства: размер и цвет-заглушка.
 * Стоимость, время, лимиты и характеристики по уровням — в balance.ts.
 */

export const BUILDING_TYPES = ['townhall', 'goldmine', 'farm', 'barracks', 'tower', 'wall'] as const;

export type BuildingType = (typeof BUILDING_TYPES)[number];

export interface BuildingConfig {
  type: BuildingType;
  /** Сторона квадратного основания в клетках. */
  size: number;
  /** Цвет-заглушка, 0xRRGGBB. */
  color: number;
}

export const BUILDINGS: Readonly<Record<BuildingType, BuildingConfig>> = {
  townhall: { type: 'townhall', size: 3, color: 0xc0392b },
  goldmine: { type: 'goldmine', size: 2, color: 0xf1c40f },
  farm: { type: 'farm', size: 2, color: 0x7cb342 },
  barracks: { type: 'barracks', size: 2, color: 0x8e44ad },
  tower: { type: 'tower', size: 1, color: 0x546e7a },
  wall: { type: 'wall', size: 1, color: 0x95a5a6 },
};

export function isBuildingType(value: unknown): value is BuildingType {
  return typeof value === 'string' && (BUILDING_TYPES as readonly string[]).includes(value);
}

/** Размер игрового поля базы в клетках. */
export const BASE_GRID_SIZE = 12;

/** Здания, с которыми начинает новый игрок: ратуша в центре поля. */
export const STARTING_BUILDINGS: readonly { type: BuildingType; x: number; y: number }[] = [
  {
    type: 'townhall',
    x: Math.floor((BASE_GRID_SIZE - BUILDINGS.townhall.size) / 2),
    y: Math.floor((BASE_GRID_SIZE - BUILDINGS.townhall.size) / 2),
  },
];
