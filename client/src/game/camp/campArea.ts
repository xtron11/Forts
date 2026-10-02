import { footprintSize, type BuildingPlacement, type PlacedBuilding } from '@forts/shared';

/** Прямоугольник клеток лагеря: левый верхний угол (x, y) и размер w × h. */
export interface CampRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Точка на поле в клетках (дробная). */
export interface FieldPoint {
  col: number;
  row: number;
}

/** Сколько пустых клеток между прямоугольником и зданием (0 — вплотную). */
function gapTo(r: CampRect, b: BuildingPlacement): number {
  const s = footprintSize(b.type);
  const dx = Math.max(0, b.x - (r.x + r.w), r.x - (b.x + s));
  const dy = Math.max(0, b.y - (r.y + r.h), r.y - (b.y + s));
  return Math.max(dx, dy);
}

/**
 * Площадка, где стоят войска: основание лагеря. Лагерей несколько — самый
 * старший уровнем (при равенстве — первый). null — лагеря нет.
 */
export function findCampRect(buildings: readonly PlacedBuilding[]): CampRect | null {
  let best: PlacedBuilding | undefined;
  for (const b of buildings) {
    if (b.type === 'camp' && (!best || b.level > best.level)) best = b;
  }
  if (!best) return null;
  const size = footprintSize(best.type);
  return { x: best.x, y: best.y, w: size, h: size };
}

/** Где появляется новый юнит: у ближайшей к лагерю казармы, со стороны лагеря. */
export function campSpawn(buildings: readonly BuildingPlacement[], rect: CampRect): FieldPoint {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const barracks = buildings.filter((b) => b.type === 'barracks');
  const b = barracks.reduce<BuildingPlacement | undefined>((a, c) => (!a || gapTo(rect, c) < gapTo(rect, a) ? c : a), undefined);
  if (!b) return { col: cx, row: cy };
  const s = footprintSize(b.type);
  let col = Math.min(Math.max(cx, b.x), b.x + s);
  let row = Math.min(Math.max(cy, b.y), b.y + s);
  const len = Math.hypot(cx - col, cy - row);
  if (len > 0) {
    col += ((cx - col) / len) * 0.3;
    row += ((cy - row) / len) * 0.3;
  }
  return { col, row };
}

export function insideRect(r: CampRect, p: FieldPoint): boolean {
  return p.col >= r.x && p.col <= r.x + r.w && p.row >= r.y && p.row <= r.y + r.h;
}
