import { BASE_GRID_SIZE, footprintSize, type BuildingPlacement } from '@forts/shared';
import type { DepthBox } from '../depthSort';
import { TILE_H, TILE_W } from '../iso';

export interface Cell {
  col: number;
  row: number;
}

/** Направления в атласе: s — вниз по экрану, e — вправо и т. д. */
export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Направления по секторам угла на экране: 0 — вправо, дальше по часовой (ось y вниз). */
const BY_SECTOR: readonly Direction[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

export function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

/**
 * Направление взгляда по смещению в клетках (dc, dr). Смещение переводится
 * в экранное и округляется до ближайшего из 8 направлений.
 */
export function directionOf(dc: number, dr: number): Direction {
  const sx = ((dc - dr) * TILE_W) / 2;
  const sy = ((dc + dr) * TILE_H) / 2;
  const sector = Math.round(Math.atan2(sy, sx) / (Math.PI / 4));
  return BY_SECTOR[(sector + 8) % 8]!;
}

/** Проходимость клеток базы: занято всё, что под зданиями (включая стены). */
export class WalkGrid {
  private readonly blocked: Uint8Array;

  constructor(
    buildings: readonly BuildingPlacement[],
    readonly size: number = BASE_GRID_SIZE,
  ) {
    this.blocked = new Uint8Array(size * size);
    for (const b of buildings) {
      const s = footprintSize(b.type);
      for (let row = b.y; row < b.y + s; row++) {
        for (let col = b.x; col < b.x + s; col++) {
          if (this.inside(col, row)) this.blocked[row * size + col] = 1;
        }
      }
    }
  }

  inside(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.size && row < this.size;
  }

  isFree(col: number, row: number): boolean {
    return this.inside(col, row) && this.blocked[row * this.size + col] === 0;
  }
}

/** Сколько клеток от клетки до квадрата (0 — внутри, 1 — вплотную, в т. ч. по диагонали). */
function distanceToRect(c: Cell, r: DepthBox): number {
  const dx = Math.max(r.x - c.col, 0, c.col - (r.x + r.size - 1));
  const dy = Math.max(r.y - c.row, 0, c.row - (r.y + r.size - 1));
  return Math.max(dx, dy);
}

/**
 * Свободные клетки вокруг квадрата на наименьшем доступном расстоянии
 * (обычно вплотную). Сначала — ближние к зрителю и к середине стороны,
 * чтобы строителя не закрывало само здание.
 */
export function spotsAround(grid: WalkGrid, rect: DepthBox, exclude: (c: Cell) => boolean = () => false): Cell[] {
  let best = Infinity;
  let spots: Cell[] = [];
  for (let row = 0; row < grid.size; row++) {
    for (let col = 0; col < grid.size; col++) {
      const c = { col, row };
      if (!grid.isFree(col, row) || exclude(c)) continue;
      const d = distanceToRect(c, rect);
      if (d < best) {
        best = d;
        spots = [];
      }
      if (d === best) spots.push(c);
    }
  }
  // Вертикальная ось квадрата на экране: col - row = rect.x - rect.y.
  const offAxis = (c: Cell) => Math.abs(c.col - c.row - (rect.x - rect.y));
  return spots.sort((a, b) => b.col + b.row - (a.col + a.row) || offAxis(a) - offAxis(b));
}

const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function octile(a: Cell, b: Cell): number {
  const dx = Math.abs(a.col - b.col);
  const dy = Math.abs(a.row - b.row);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * A* по свободным клеткам в 8 направлениях до ближайшей из целей.
 * По диагонали — только если обе соседние клетки свободны, чтобы не
 * срезать углы зданий. Старт может быть занят (на месте строителя только
 * что поставили здание) — тогда он просто выходит из него.
 * Возвращает клетки от старта до цели включительно или null, если не дойти.
 */
export function findPath(grid: WalkGrid, start: Cell, goals: readonly Cell[]): Cell[] | null {
  const n = grid.size;
  if (!grid.inside(start.col, start.row) || goals.length === 0) return null;
  const index = (col: number, row: number) => row * n + col;
  const isGoal = new Uint8Array(n * n);
  for (const g of goals) if (grid.isFree(g.col, g.row)) isGoal[index(g.col, g.row)] = 1;
  const h = (c: Cell) => Math.min(...goals.map((g) => octile(c, g)));

  const cost = new Float64Array(n * n).fill(Infinity);
  const estimate = new Float64Array(n * n).fill(Infinity);
  const parent = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const open: number[] = [index(start.col, start.row)];
  cost[open[0]!] = 0;
  estimate[open[0]!] = h(start);

  while (open.length > 0) {
    // Поле маленькое (12×12) — линейный поиск минимума проще и не медленнее кучи.
    let bestAt = 0;
    for (let i = 1; i < open.length; i++) if (estimate[open[i]!]! < estimate[open[bestAt]!]!) bestAt = i;
    const current = open.splice(bestAt, 1)[0]!;
    const col = current % n;
    const row = Math.floor(current / n);
    if (isGoal[current]) {
      const path: Cell[] = [];
      for (let i = current; i !== -1; i = parent[i]!) path.push({ col: i % n, row: Math.floor(i / n) });
      return path.reverse();
    }
    closed[current] = 1;
    for (const [dc, dr] of STEPS) {
      const nc = col + dc;
      const nr = row + dr;
      if (!grid.isFree(nc, nr)) continue;
      if (dc !== 0 && dr !== 0 && (!grid.isFree(col + dc, row) || !grid.isFree(col, row + dr))) continue;
      const next = index(nc, nr);
      if (closed[next]) continue;
      const g = cost[current]! + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1);
      if (g >= cost[next]!) continue;
      if (cost[next] === Infinity) open.push(next);
      cost[next] = g;
      estimate[next] = g + h({ col: nc, row: nr });
      parent[next] = current;
    }
  }
  return null;
}
