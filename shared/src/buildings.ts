/**
 * Конфиг зданий — единственный источник игровых чисел по зданиям.
 * Пока только размер и цвет-заглушка; стоимость, время постройки и
 * характеристики появятся здесь же.
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

/** Размер игрового поля базы в клетках. */
export const BASE_GRID_SIZE = 12;
