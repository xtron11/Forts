import { BASE_GRID_SIZE, BUILDINGS, isBuildingType, type BuildingType } from './buildings';

/** Положение здания; x/y — клетка основания с минимальными координатами. */
export interface BuildingPlacement {
  type: BuildingType;
  x: number;
  y: number;
}

/** Здание на базе игрока. */
export interface PlacedBuilding extends BuildingPlacement {
  id: number;
  level: number;
}

export function footprintSize(type: BuildingType): number {
  return BUILDINGS[type].size;
}

export type PlacementError = 'unknown_building_type' | 'out_of_bounds' | 'overlap' | 'limit_reached';

export type PlacementCheck = { ok: true } | { ok: false; reason: PlacementError };

/**
 * Можно ли поставить здание: тип существует, координаты — целые, основание
 * влезает в поле, не пересекается с другими и не превышен лимит по типу.
 * Клиент использует для подсветки, сервер — для окончательного решения,
 * поэтому type принимается как произвольная строка.
 */
export function checkPlacement(
  buildings: readonly BuildingPlacement[],
  type: string,
  x: number,
  y: number,
  gridSize: number = BASE_GRID_SIZE,
): PlacementCheck {
  if (!isBuildingType(type)) return { ok: false, reason: 'unknown_building_type' };
  const size = footprintSize(type);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + size > gridSize || y + size > gridSize) {
    return { ok: false, reason: 'out_of_bounds' };
  }
  const overlaps = buildings.some((b) => {
    const s = footprintSize(b.type);
    return x < b.x + s && b.x < x + size && y < b.y + s && b.y < y + size;
  });
  if (overlaps) return { ok: false, reason: 'overlap' };
  const { maxCount } = BUILDINGS[type];
  if (maxCount !== undefined && buildings.filter((b) => b.type === type).length >= maxCount) {
    return { ok: false, reason: 'limit_reached' };
  }
  return { ok: true };
}

export function canPlaceBuilding(
  buildings: readonly BuildingPlacement[],
  type: string,
  x: number,
  y: number,
  gridSize: number = BASE_GRID_SIZE,
): boolean {
  return checkPlacement(buildings, type, x, y, gridSize).ok;
}
