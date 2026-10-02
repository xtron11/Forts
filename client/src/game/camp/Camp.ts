import type { ArmyStack, PlacedBuilding, TroopType } from '@forts/shared';
import { directionOf, type Direction } from '../builder/grid';
import type { DepthBox } from '../depthSort';
import { campSpawn, findCampRect, insideRect, type CampRect, type FieldPoint } from './campArea';

/**
 * Сколько юнитов одного войска стоит в лагере, сколько бы их ни было в
 * армии: остальных обозначает число над ним. Меньше спрайтов — легче телефону.
 */
export const CAMP_UNITS_PER_TROOP = 1;
/** Сколько юнит стоит между прогулками, мс. */
export const CAMP_IDLE_MS = { min: 4000, max: 10_000 } as const;
/** Одновременно гуляет не больше такой доли лагеря (но хотя бы один). */
export const CAMP_WANDER_SHARE = 0.3;
/** Точка прогулки не ближе стольких клеток к другим юнитам и их целям. */
export const CAMP_MIN_GAP = 1;
/** Отступ точки от края лагеря, клетки. */
const EDGE = 0.3;
/** Сколько случайных точек пробуем, прежде чем отказаться от прогулки. */
const SPOT_TRIES = 16;

/** arriving — идёт в лагерь от казармы (или в переехавший лагерь). */
export type CampState = 'arriving' | 'idle' | 'wandering';

export class CampUnit {
  state: CampState = 'idle';
  /** Положение ног в клетках. */
  col = 0;
  row = 0;
  dir: Direction = 's';
  target: FieldPoint | null = null;
  /** Сколько ещё стоять до попытки прогулки, мс. */
  idleLeft = 0;

  constructor(
    readonly id: number,
    readonly troop: TroopType,
  ) {}

  /** В лагере юнит стоит (idle) или идёт шагом (walk). */
  get anim(): 'idle' | 'walk' {
    return this.state === 'idle' ? 'idle' : 'walk';
  }

  /** Квадрат под ногами для сортировки по глубине вместе со зданиями. */
  depthBox(): DepthBox {
    return { x: this.col - 0.5, y: this.row - 0.5, size: 1 };
  }
}

/**
 * Войска в лагере — только картинка: каких сколько, приходит с сервера
 * (army.troops); на площадке по CAMP_UNITS_PER_TROOP юнитов каждого войска.
 * Каждый юнит: idle → wandering → idle; новые приходят от казармы,
 * отправленные в бой исчезают.
 */
export class Camp {
  readonly units: CampUnit[] = [];
  rect: CampRect | null = null;
  /** Сколько юнитов каждого войска в армии на самом деле. */
  readonly counts = new Map<TroopType, number>();
  private nextId = 1;
  private synced = false;

  constructor(
    /** Скорость шага войска в лагере, клеток в секунду. */
    private readonly walkSpeed: (troop: TroopType) => number,
    private readonly random: () => number = Math.random,
  ) {}

  /** Новое состояние базы. При первом вызове (вход в игру) юниты сразу стоят в лагере. */
  sync(buildings: readonly PlacedBuilding[], army: { troops: readonly ArmyStack[] }): void {
    const instant = !this.synced;
    this.synced = true;
    this.counts.clear();
    for (const s of army.troops) this.counts.set(s.troop, (this.counts.get(s.troop) ?? 0) + s.count);
    this.rect = findCampRect(buildings);
    if (!this.rect) {
      this.units.length = 0;
      return;
    }
    const rect = this.rect;

    const want = new Map<TroopType, number>();
    for (const [troop, count] of this.counts) want.set(troop, Math.min(count, CAMP_UNITS_PER_TROOP));
    // Лишние (ушли в бой) убираем: последние пришедшие — первыми.
    const kept = new Map<TroopType, number>();
    const keep = this.units.filter((u) => {
      const n = kept.get(u.troop) ?? 0;
      if (n >= (want.get(u.troop) ?? 0)) return false;
      kept.set(u.troop, n + 1);
      return true;
    });
    this.units.splice(0, this.units.length, ...keep);

    // Лагерь переехал (на его месте построили здание) — кто снаружи, идёт внутрь.
    for (const u of this.units) {
      const at = u.target ?? u;
      if (!insideRect(rect, at)) this.goTo(u, this.freeSpot(u) ?? this.randomPoint(), 'arriving');
    }

    const spawn = campSpawn(buildings, rect);
    for (const [troop, count] of want) {
      for (let i = kept.get(troop) ?? 0; i < count; i++) {
        const u = new CampUnit(this.nextId++, troop);
        const spot = this.freeSpot(u) ?? this.randomPoint();
        if (instant) {
          u.col = spot.col;
          u.row = spot.row;
          this.rest(u);
        } else {
          u.col = spawn.col;
          u.row = spawn.row;
          this.goTo(u, spot, 'arriving');
        }
        this.units.push(u);
      }
    }
  }

  /**
   * Шаг для юнитов, для которых active() — true (остальные за экраном и
   * стоят на паузе вместе с таймерами). true — кто-то сдвинулся.
   */
  update(deltaMs: number, active: (u: CampUnit) => boolean = () => true): boolean {
    let moved = false;
    let wandering = this.units.filter((u) => u.state === 'wandering').length;
    const limit = Math.max(1, Math.floor(this.units.length * CAMP_WANDER_SHARE));
    for (const u of this.units) {
      if (!active(u)) continue;
      if (u.state !== 'idle') {
        moved = this.step(u, deltaMs) || moved;
        continue;
      }
      u.idleLeft -= deltaMs;
      if (u.idleLeft > 0) continue;
      u.idleLeft = this.idleTime();
      if (wandering >= limit) continue;
      const spot = this.freeSpot(u);
      if (!spot) continue;
      this.goTo(u, spot, 'wandering');
      wandering++;
    }
    return moved;
  }

  private step(u: CampUnit, deltaMs: number): boolean {
    const target = u.target;
    if (!target) {
      this.rest(u);
      return false;
    }
    const budget = (this.walkSpeed(u.troop) * deltaMs) / 1000;
    const dx = target.col - u.col;
    const dy = target.row - u.row;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      u.col = target.col;
      u.row = target.row;
      // Дошёл — стоит, глядя туда же, куда шёл.
      this.rest(u);
    } else {
      u.dir = directionOf(dx, dy);
      u.col += (dx / dist) * budget;
      u.row += (dy / dist) * budget;
    }
    return true;
  }

  private goTo(u: CampUnit, spot: FieldPoint, state: 'arriving' | 'wandering'): void {
    u.target = spot;
    u.state = state;
    if (spot.col !== u.col || spot.row !== u.row) u.dir = directionOf(spot.col - u.col, spot.row - u.row);
  }

  private rest(u: CampUnit): void {
    u.state = 'idle';
    u.target = null;
    u.idleLeft = this.idleTime();
  }

  private idleTime(): number {
    return CAMP_IDLE_MS.min + this.random() * (CAMP_IDLE_MS.max - CAMP_IDLE_MS.min);
  }

  private randomPoint(): FieldPoint {
    const r = this.rect!;
    const along = (from: number, len: number) => (len > 2 * EDGE ? from + EDGE + this.random() * (len - 2 * EDGE) : from + len / 2);
    return { col: along(r.x, r.w), row: along(r.y, r.h) };
  }

  /** Случайная точка лагеря не ближе CAMP_MIN_GAP к себе, другим юнитам и их целям; undefined — места нет. */
  private freeSpot(self: CampUnit): FieldPoint | undefined {
    for (let i = 0; i < SPOT_TRIES; i++) {
      const p = this.randomPoint();
      const far = (q: FieldPoint) => Math.hypot(q.col - p.col, q.row - p.row) >= CAMP_MIN_GAP;
      if (!far(self)) continue;
      if (this.units.every((u) => u === self || (far(u) && (!u.target || far(u.target))))) return p;
    }
    return undefined;
  }
}
