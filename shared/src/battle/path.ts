/**
 * Поиск пути A* по клеткам поля боя (8 направлений, без срезания углов).
 *
 * Живые здания — препятствия, но не непроходимые: вход в клетку стены стоит
 * лишние wallCost, в клетку другого здания — ещё больше. Так один проход A*
 * решает, обходить стену или ломать: если обход длиннее, чем wallCost,
 * путь идёт сквозь стену, и юнит ломает её, дойдя до неё.
 */
import { TILE } from '../troops';
import { distSqToRect, type Rect } from './math';

/** Цена шага по прямой и по диагонали. */
export const STEP_COST = 10;
const DIAGONAL_COST = 14;

export interface PathGrid {
  /** Сторона поля в клетках. */
  size: number;
  /** Сдвиг поля относительно координат базы, клеток. */
  margin: number;
  /** Для каждой клетки: индекс живого здания + 1; 0 — свободно. */
  occupant: Int32Array;
  /** 1 — здание с этим индексом стена. */
  wall: Uint8Array;
  /** Цена входа в клетку здания, которое не стена и не цель. */
  buildingCost: number;
}

export interface PathQuery {
  /** Клетка старта (индекс y * size + x). */
  start: number;
  /** Индекс здания-цели. */
  target: number;
  /** Прямоугольник цели в единицах длины (координаты базы). */
  targetRect: Rect;
  /** Радиус атаки: путь заканчивается в клетке, из центра которой цель в радиусе. */
  range: number;
  /** Лишняя цена входа в клетку стены. */
  wallCost: number;
}

/** Центр клетки поля в единицах длины координат базы. */
export function tileCenter(grid: PathGrid, tile: number): { x: number; y: number } {
  const tx = tile % grid.size;
  const ty = (tile - tx) / grid.size;
  return { x: (tx - grid.margin) * TILE + TILE / 2, y: (ty - grid.margin) * TILE + TILE / 2 };
}

/** Клетка поля, в которой лежит точка (координаты базы); -1 — вне поля. */
export function tileAt(grid: PathGrid, x: number, y: number): number {
  const tx = Math.floor(x / TILE) + grid.margin;
  const ty = Math.floor(y / TILE) + grid.margin;
  if (tx < 0 || ty < 0 || tx >= grid.size || ty >= grid.size) return -1;
  return ty * grid.size + tx;
}

/** Двоичная куча чисел (минимум сверху). */
class MinHeap {
  private items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(v: number): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= v) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = v;
  }

  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && a[r]! < a[l]! ? r : l;
        if (a[c]! >= last) break;
        a[i] = a[c]!;
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

const DIRS: readonly (readonly [dx: number, dy: number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Ключ кучи: f, при равенстве — меньший индекс клетки. */
const KEY_SCALE = 1 << 20;

/**
 * Путь от start до ближайшей (по цене) клетки, откуда цель в радиусе.
 * Возвращает клетки от start до конца включительно; клетки с живыми
 * зданиями на пути юнит сначала ломает. Порядок обхода фиксирован, так
 * что результат зависит только от входа.
 */
export function findPath(grid: PathGrid, q: PathQuery): number[] {
  const { size, occupant } = grid;
  const n = size * size;
  const rangeSq = q.range * q.range;

  // Клетки цели для эвристики (координаты поля, включительно).
  const tx0 = Math.floor(q.targetRect.minX / TILE) + grid.margin;
  const ty0 = Math.floor(q.targetRect.minY / TILE) + grid.margin;
  const tx1 = Math.ceil(q.targetRect.maxX / TILE) - 1 + grid.margin;
  const ty1 = Math.ceil(q.targetRect.maxY / TILE) - 1 + grid.margin;
  const slack = Math.ceil(q.range / TILE) + 1;
  const heuristic = (tile: number): number => {
    const x = tile % size;
    const y = (tile - x) / size;
    const gx = x < tx0 ? tx0 - x : x > tx1 ? x - tx1 : 0;
    const gy = y < ty0 ? ty0 - y : y > ty1 ? y - ty1 : 0;
    const cheb = gx > gy ? gx : gy;
    return cheb > slack ? (cheb - slack) * STEP_COST : 0;
  };
  const isGoal = (tile: number): boolean => {
    if (occupant[tile] !== 0) return false;
    const c = tileCenter(grid, tile);
    return distSqToRect(c.x, c.y, q.targetRect) <= rangeSq;
  };
  /** Цена входа в клетку; -1 — нельзя (цель). */
  const enterCost = (tile: number): number => {
    const occ = occupant[tile]!;
    if (occ === 0) return 0;
    const b = occ - 1;
    if (b === q.target) return -1;
    return grid.wall[b] ? q.wallCost : grid.buildingCost;
  };

  const g = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  g[q.start] = 0;
  heap.push(heuristic(q.start) * KEY_SCALE + q.start);

  let goal = -1;
  while (heap.size > 0) {
    const key = heap.pop();
    const cur = key % KEY_SCALE;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (isGoal(cur)) {
      goal = cur;
      break;
    }
    const cx = cur % size;
    const cy = (cur - cx) / size;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const next = ny * size + nx;
      if (closed[next]) continue;
      const extra = enterCost(next);
      if (extra < 0) continue;
      let step = STEP_COST;
      if (dx !== 0 && dy !== 0) {
        // По диагонали — только между свободными клетками.
        if (extra !== 0 || occupant[cy * size + nx] !== 0 || occupant[ny * size + cx] !== 0) continue;
        step = DIAGONAL_COST;
      }
      const cost = g[cur]! + step + extra;
      if (g[next] !== -1 && g[next]! <= cost) continue;
      g[next] = cost;
      parent[next] = cur;
      heap.push((cost + heuristic(next)) * KEY_SCALE + next);
    }
  }

  if (goal < 0) return [q.start];
  const path: number[] = [];
  for (let t = goal; t !== -1; t = parent[t]!) path.push(t);
  return path.reverse();
}
