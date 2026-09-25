import { BASE_GRID_SIZE, BUILDINGS, isBuildingType, type BuildingType } from './buildings';

/** Положение здания; x/y — клетка основания с минимальными координатами. */
export interface BuildingPlacement {
  type: BuildingType;
  x: number;
  y: number;
}

/**
 * Здание на базе игрока. Времена — миллисекунды Unix-времени сервера.
 * Пока finishAt не null, здание строится (level 0) или улучшается до
 * level + 1; когда наступает finishAt, стройка завершена (settleBuilding).
 */
export interface PlacedBuilding extends BuildingPlacement {
  id: number;
  /** Готовый уровень; 0 — новое здание ещё строится. */
  level: number;
  finishAt: number | null;
  /** С какого момента идёт добыча (шахта, ферма). */
  collectedAt: number;
  /** Сколько уже лежало в здании к collectedAt; во время улучшения добыча стоит на этом значении. */
  stored: number;
}

export function footprintSize(type: BuildingType): number {
  return BUILDINGS[type].size;
}

export type PlacementError = 'unknown_building_type' | 'out_of_bounds' | 'overlap';

export type PlacementCheck = { ok: true } | { ok: false; reason: PlacementError };

/**
 * Можно ли поставить здание на это место: тип существует, координаты —
 * целые, основание влезает в поле и не пересекается с другими. Лимиты,
 * ресурсы и строители — отдельно, в checkBuild (economy.ts).
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
