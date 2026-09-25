/**
 * Целочисленная арифметика боя. Все значения — целые числа меньше 2^53,
 * поэтому операции JS над ними точные и одинаковые на любой платформе.
 */

/** Целая часть квадратного корня. Math.sqrt по стандарту IEEE точно округлён, а цикл доводит результат до точного. */
export function isqrt(n: number): number {
  if (n < 2) return n < 0 ? 0 : n;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** Деление с отбрасыванием дробной части (к нулю). */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Квадрат расстояния от точки до прямоугольника (0 — внутри). */
export function distSqToRect(x: number, y: number, r: Rect): number {
  const dx = x < r.minX ? r.minX - x : x > r.maxX ? x - r.maxX : 0;
  const dy = y < r.minY ? r.minY - y : y > r.maxY ? y - r.maxY : 0;
  return dx * dx + dy * dy;
}

/**
 * Генератор псевдослучайных чисел mulberry32: 32-битное состояние, только
 * целочисленные операции. Вся случайность боя — отсюда, из seed.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Целое 0..2^32−1. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Целое 0..n−1. */
  int(n: number): number {
    return n <= 1 ? 0 : this.next() % n;
  }

  get seedState(): number {
    return this.state;
  }
}

/** FNV-1a над 32-битными целыми. */
export class Hasher {
  private h = 0x811c9dc5;

  add(value: number): this {
    // Число может не влезать в 32 бита — добавляем старшую и младшую части.
    const lo = value >>> 0;
    const hi = Math.floor(value / 0x1_0000_0000) >>> 0;
    this.mix(lo);
    this.mix(hi);
    return this;
  }

  private mix(word: number): void {
    for (let i = 0; i < 4; i++) {
      this.h ^= (word >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193) >>> 0;
    }
  }

  get value(): number {
    return this.h >>> 0;
  }
}
