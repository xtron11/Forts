import { BASE_GRID_SIZE, BUILDINGS, type BuildingType } from './buildings';

/** Здание на базе; col/row — клетка с минимальными координатами. */
export interface PlacedBuilding {
  id: number;
  type: BuildingType;
  col: number;
  row: number;
}

export function footprintSize(type: BuildingType): number {
  return BUILDINGS[type].size;
}

/** Можно ли поставить здание: влезает в поле и не пересекается с другими. */
export function canPlaceBuilding(
  buildings: readonly PlacedBuilding[],
  type: BuildingType,
  col: number,
  row: number,
  gridSize: number = BASE_GRID_SIZE,
): boolean {
  const size = footprintSize(type);
  if (col < 0 || row < 0 || col + size > gridSize || row + size > gridSize) return false;
  return buildings.every((b) => {
    const s = footprintSize(b.type);
    return col + size <= b.col || b.col + s <= col || row + size <= b.row || b.row + s <= row;
  });
}
