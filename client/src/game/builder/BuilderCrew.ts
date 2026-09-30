import { BASE_GRID_SIZE, BUILDER_COUNT, type PlacedBuilding } from '@forts/shared';
import { buildingBox, type DepthBox } from '../depthSort';
import { Builder } from './Builder';
import { findPath, sameCell, spotsAround, WalkGrid, type Cell } from './grid';

/**
 * Строители базы. Кто что строит, определяется только по данным сервера:
 * здание с finishAt !== null — стройка, ей нужен строитель. Таймеры и
 * завершение стройки считает сервер; здесь лишь решаем, куда идти.
 */
export class BuilderCrew {
  readonly builders: Builder[];
  private synced = false;

  constructor(count: number = BUILDER_COUNT) {
    this.builders = Array.from({ length: count }, () => new Builder());
  }

  /**
   * Новое состояние базы. При первом вызове (вход в игру) строители
   * сразу встают на места — у идущих строек уже работают.
   */
  sync(buildings: readonly PlacedBuilding[]): void {
    const instant = !this.synced;
    this.synced = true;
    const grid = new WalkGrid(buildings);
    const key = (c: Cell) => c.row * grid.size + c.col;

    // Дома: у каждого строителя своя клетка у ратуши.
    const townhall = buildings.find((b) => b.type === 'townhall');
    const homeRect: DepthBox = townhall ? buildingBox(townhall) : { x: BASE_GRID_SIZE / 2, y: BASE_GRID_SIZE / 2, size: 1 };
    const homeKeys = new Set<number>();
    const homes = this.builders.map(() => {
      const home = spotsAround(grid, homeRect, (c) => homeKeys.has(key(c)))[0];
      if (home) homeKeys.add(key(home));
      return home;
    });

    // Раздаём стройки: сначала те, что закончатся раньше; занятые строители остаются на своих.
    const sites = buildings.filter((b) => b.finishAt !== null).sort((a, b) => a.finishAt! - b.finishAt! || a.id - b.id);
    for (const b of this.builders) {
      if (b.targetId !== null && !sites.some((s) => s.id === b.targetId)) b.targetId = null;
    }
    for (const site of sites) {
      if (this.builders.some((b) => b.targetId === site.id)) continue;
      const free = this.builders.find((b) => b.targetId === null);
      if (free) free.targetId = site.id;
    }

    // Клетки, куда уже встали или идут другие строители, и чужие дома.
    const claimed = new Set<number>();
    this.builders.forEach((b, i) => {
      const site = b.targetId === null ? undefined : sites.find((s) => s.id === b.targetId);
      const target = site ? { id: site.id, rect: buildingBox(site) } : null;
      const ownHome = homes[i];
      const taken = (c: Cell) => claimed.has(key(c)) || (homeKeys.has(key(c)) && !(ownHome && sameCell(c, ownHome)));
      let goals: Cell[];
      if (target) {
        goals = spotsAround(grid, target.rect, taken);
        if (goals.length === 0) goals = spotsAround(grid, target.rect);
      } else {
        goals = ownHome ? [ownHome] : [];
      }
      if (goals.length === 0) return; // Поле забито — стоит где стоит.

      // Если уже стоит (или идёт) на подходящую клетку — не меняем её.
      const keep = b.dest ? goals.find((g) => sameCell(g, b.dest!)) : undefined;
      if (instant) {
        b.placeAt(keep ?? goals[0]!, target);
      } else if (keep && !b.walking && grid.isFree(keep.col, keep.row)) {
        b.retarget(target);
      } else {
        const path = findPath(grid, b.startCell, keep ? [keep] : goals);
        // Пути нет (стройка за стенами) — строитель просто переставляется.
        if (path) b.walk(path, target);
        else b.placeAt(goals[0]!, target, true);
      }
      if (b.dest) claimed.add(key(b.dest));
    });
  }

  /** true — кто-то сдвинулся. */
  update(deltaMs: number): boolean {
    let moved = false;
    for (const b of this.builders) moved = b.update(deltaMs) || moved;
    return moved;
  }
}
