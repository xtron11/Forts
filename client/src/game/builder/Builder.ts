import type { DepthBox } from '../depthSort';
import { directionOf, type Cell, type Direction } from './grid';

export type BuilderState = 'idle' | 'walkingToBuilding' | 'building' | 'returning';

/** Анимация, которую просит состояние; если её нет в атласе, играет idle. */
export type BuilderAnim = 'idle' | 'walk' | 'work';

const ANIM_BY_STATE: Readonly<Record<BuilderState, BuilderAnim>> = {
  idle: 'idle',
  walkingToBuilding: 'walk',
  building: 'work',
  returning: 'walk',
};

/**
 * Скорость ходьбы, клеток в секунду. Только визуальный параметр. Шаг
 * анимации walk (12 кадров при 12 fps) проходит около 0,7 клетки — чем ближе
 * к этому, тем меньше ноги «скользят» по земле.
 */
export const BUILDER_SPEED = 1;

/** Стройка, к которой приставлен строитель. */
export interface BuilderTarget {
  id: number;
  rect: DepthBox;
}

/**
 * Строитель — только визуальная часть: где стоит и что делает, решается
 * по данным сервера (BuilderCrew), здесь — движение по готовому пути.
 *
 * idle → walkingToBuilding → building → returning → idle
 */
export class Builder {
  state: BuilderState = 'idle';
  /** Здание, которое строит или к которому идёт; null — свободен. */
  targetId: number | null = null;
  /** Положение ног в клетках; середина клетки (c, r) — (c + 0.5, r + 0.5). */
  col = 0.5;
  row = 0.5;
  dir: Direction = 's';
  /** Клетка, где стоит или куда идёт. */
  dest: Cell | null = null;
  /** Сколько раз переставлен без ходьбы (пути нет) — вид мигает при каждом. */
  teleports = 0;
  private face: DepthBox | null = null;
  private path: Cell[] = [];
  private step = 0;

  get anim(): BuilderAnim {
    return ANIM_BY_STATE[this.state];
  }

  get walking(): boolean {
    return this.state === 'walkingToBuilding' || this.state === 'returning';
  }

  /** Стоит на месте в конечном состоянии: у стройки (есть цель) или у ратуши (нет). */
  get settled(): boolean {
    return this.state === (this.targetId === null ? 'idle' : 'building');
  }

  /** Клетка, от которой строить новый путь: в пути — ближайшая точка маршрута, иначе — та, где стоит. */
  get startCell(): Cell {
    if (this.walking && this.path[this.step]) return this.path[this.step]!;
    return { col: Math.floor(this.col), row: Math.floor(this.row) };
  }

  /** Квадрат под ногами для сортировки по глубине вместе со зданиями. */
  depthBox(): DepthBox {
    return { x: this.col - 0.5, y: this.row - 0.5, size: 1 };
  }

  /** Сменить цель, не двигаясь (уже стоит где нужно). */
  retarget(target: BuilderTarget | null): void {
    this.targetId = target?.id ?? null;
    this.face = target?.rect ?? null;
    if (!this.walking) this.arrive();
  }

  /** Сразу поставить на клетку: вход в игру посреди стройки или когда пути нет. */
  placeAt(cell: Cell, target: BuilderTarget | null, teleport = false): void {
    this.targetId = target?.id ?? null;
    this.face = target?.rect ?? null;
    this.dest = cell;
    this.col = cell.col + 0.5;
    this.row = cell.row + 0.5;
    if (teleport) this.teleports++;
    this.arrive();
  }

  /** Идти по пути (от startCell до цели); к стройке — walkingToBuilding, домой — returning. */
  walk(path: Cell[], target: BuilderTarget | null): void {
    this.targetId = target?.id ?? null;
    this.face = target?.rect ?? null;
    this.dest = path[path.length - 1] ?? null;
    this.path = path;
    this.step = 0;
    this.state = target ? 'walkingToBuilding' : 'returning';
  }

  /** Шаг движения. true — строитель сдвинулся (нужно пересчитать глубину). */
  update(deltaMs: number): boolean {
    if (!this.walking) return false;
    let budget = (BUILDER_SPEED * deltaMs) / 1000;
    while (budget > 0 && this.step < this.path.length) {
      const next = this.path[this.step]!;
      const dx = next.col + 0.5 - this.col;
      const dy = next.row + 0.5 - this.row;
      const dist = Math.hypot(dx, dy);
      // Направление — по текущему отрезку, поэтому на каждом повороте оно меняется.
      if (dist > 1e-6) this.dir = directionOf(dx, dy);
      if (dist <= budget) {
        this.col = next.col + 0.5;
        this.row = next.row + 0.5;
        budget -= dist;
        this.step++;
      } else {
        this.col += (dx / dist) * budget;
        this.row += (dy / dist) * budget;
        budget = 0;
      }
    }
    if (this.step >= this.path.length) this.arrive();
    return true;
  }

  private arrive(): void {
    this.path = [];
    this.step = 0;
    this.state = this.targetId === null ? 'idle' : 'building';
    if (this.face) {
      // Лицом к середине здания.
      const cx = this.face.x + this.face.size / 2;
      const cy = this.face.y + this.face.size / 2;
      this.dir = directionOf(cx - this.col, cy - this.row);
    } else {
      this.dir = 's';
    }
  }
}
