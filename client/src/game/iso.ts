/** Размер ромба одной клетки в мировых единицах. */
export const TILE_W = 64;
export const TILE_H = 32;

export interface Point {
  x: number;
  y: number;
}

/**
 * Мировые координаты верхней вершины клетки. Ось col идёт вправо-вниз,
 * row — влево-вниз; клетка (0, 0) — верхний угол поля.
 */
export function cellToWorld(col: number, row: number): Point {
  return { x: ((col - row) * TILE_W) / 2, y: ((col + row) * TILE_H) / 2 };
}

/** Клетка, в которую попадает мировая точка (может быть вне поля). */
export function worldToCell(x: number, y: number): { col: number; row: number } {
  const u = x / (TILE_W / 2);
  const v = y / (TILE_H / 2);
  return { col: Math.floor((u + v) / 2), row: Math.floor((v - u) / 2) };
}

/** Вершины ромба прямоугольной области клеток: верх, право, низ, лево. */
export function footprintCorners(col: number, row: number, cols: number, rows: number): [Point, Point, Point, Point] {
  return [
    cellToWorld(col, row),
    cellToWorld(col + cols, row),
    cellToWorld(col + cols, row + rows),
    cellToWorld(col, row + rows),
  ];
}
