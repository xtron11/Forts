/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BuildingPlacement, PlacedBuilding } from '@forts/shared';
import { BuilderCrew } from './BuilderCrew';
import { directionOf, findPath, spotsAround, WalkGrid, type Cell } from './grid';

let nextId = 1;
function building(type: PlacedBuilding['type'], x: number, y: number, finishAt: number | null = null): PlacedBuilding {
  return { id: nextId++, type, x, y, level: finishAt === null ? 1 : 0, finishAt, collectedAt: 0, stored: 0 };
}

function walkAll(crew: BuilderCrew): void {
  for (let i = 0; i < 10_000 && crew.update(50); i++);
}

const adjacent = (c: Cell, b: BuildingPlacement, size: number) =>
  c.col >= b.x - 1 && c.col <= b.x + size && c.row >= b.y - 1 && c.row <= b.y + size && !(c.col >= b.x && c.col < b.x + size && c.row >= b.y && c.row < b.y + size);

describe('findPath', () => {
  it('обходит здание, не заходя в занятые клетки', () => {
    const walls: BuildingPlacement[] = [0, 1, 2, 3, 4].map((row) => ({ type: 'wall', x: 3, y: row }));
    const grid = new WalkGrid(walls, 8);
    const path = findPath(grid, { col: 1, row: 1 }, [{ col: 5, row: 1 }])!;
    assert.ok(path);
    assert.deepEqual(path[0], { col: 1, row: 1 });
    assert.deepEqual(path.at(-1), { col: 5, row: 1 });
    for (const c of path) assert.ok(grid.isFree(c.col, c.row), `клетка ${c.col},${c.row} занята`);
    // Каждый шаг — в соседнюю клетку, по диагонали без срезания углов.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      assert.ok(Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1);
      if (a.col !== b.col && a.row !== b.row) assert.ok(grid.isFree(b.col, a.row) && grid.isFree(a.col, b.row));
    }
  });

  it('возвращает null, если цель за сплошной стеной', () => {
    const walls: BuildingPlacement[] = [];
    for (let i = 0; i < 5; i++) walls.push({ type: 'wall', x: i, y: 4 }, { type: 'wall', x: 4, y: i });
    const grid = new WalkGrid(walls, 8);
    assert.equal(findPath(grid, { col: 7, row: 7 }, [{ col: 1, row: 1 }]), null);
  });
});

describe('spotsAround', () => {
  it('даёт свободные клетки вплотную к зданию', () => {
    const th: BuildingPlacement = { type: 'townhall', x: 4, y: 4 };
    const grid = new WalkGrid([th], 12);
    const spots = spotsAround(grid, { x: 4, y: 4, size: 3 });
    assert.equal(spots.length, 16);
    for (const s of spots) assert.ok(adjacent(s, th, 3));
    // Первой идёт клетка у ближнего к зрителю угла.
    assert.deepEqual(spots[0], { col: 7, row: 7 });
  });
});

describe('directionOf', () => {
  it('переводит шаг по клеткам в направление на экране', () => {
    assert.equal(directionOf(1, 1), 's');
    assert.equal(directionOf(-1, -1), 'n');
    assert.equal(directionOf(1, -1), 'e');
    assert.equal(directionOf(-1, 1), 'w');
    assert.equal(directionOf(1, 0), 'se');
    assert.equal(directionOf(0, 1), 'sw');
    assert.equal(directionOf(0, -1), 'ne');
    assert.equal(directionOf(-1, 0), 'nw');
  });
});

describe('BuilderCrew', () => {
  const th = building('townhall', 4, 4);

  it('без строек все стоят у ратуши в idle', () => {
    const crew = new BuilderCrew(2);
    crew.sync([th]);
    for (const b of crew.builders) {
      assert.equal(b.state, 'idle');
      assert.ok(adjacent(b.dest!, th, 3));
    }
    assert.notDeepEqual(crew.builders[0]!.dest, crew.builders[1]!.dest);
  });

  it('при входе посреди стройки строитель сразу работает у здания', () => {
    const farm = building('farm', 0, 0, 1_000);
    const crew = new BuilderCrew(2);
    crew.sync([th, farm]);
    const [b] = crew.builders;
    assert.equal(b!.state, 'building');
    assert.equal(b!.targetId, farm.id);
    assert.ok(adjacent(b!.dest!, farm, 2));
    assert.equal(crew.builders[1]!.state, 'idle');
  });

  it('проходит весь цикл idle → walkingToBuilding → building → returning → idle', () => {
    const crew = new BuilderCrew(1);
    crew.sync([th]);
    const b = crew.builders[0]!;
    const home = b.dest!;
    assert.equal(b.state, 'idle');

    // Стена вокруг угла поля — строитель должен её обойти.
    const farm = building('farm', 0, 0, 1_000);
    const walls = [building('wall', 2, 0), building('wall', 2, 1), building('wall', 2, 2)];
    crew.sync([th, ...walls, farm]);
    assert.equal(b.state, 'walkingToBuilding');
    const grid = new WalkGrid([th, ...walls, farm]);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000 && b.walking; i++) {
      crew.update(20);
      assert.ok(grid.isFree(Math.floor(b.col), Math.floor(b.row)), 'строитель зашёл в здание');
      seen.add(b.dir);
    }
    assert.equal(b.state, 'building');
    assert.ok(adjacent(b.dest!, farm, 2));
    assert.ok(seen.size > 1, 'на поворотах направление меняется');
    assert.equal(b.dir, directionOf(1 - b.col, 1 - b.row), 'лицом к зданию');

    // Сервер завершил стройку.
    crew.sync([th, ...walls, { ...farm, finishAt: null, level: 1 }]);
    assert.equal(b.state, 'returning');
    walkAll(crew);
    assert.equal(b.state, 'idle');
    assert.deepEqual(b.dest, home);
  });

  it('повторный sync той же стройки не сбивает строителя с пути', () => {
    const crew = new BuilderCrew(1);
    crew.sync([th]);
    const b = crew.builders[0]!;
    const farm = building('farm', 0, 0, 1_000);
    crew.sync([th, farm]);
    crew.update(300);
    const dest = b.dest;
    const pos = [b.col, b.row];
    crew.sync([th, farm]);
    assert.equal(b.state, 'walkingToBuilding');
    assert.deepEqual(b.dest, dest);
    assert.deepEqual([b.col, b.row], pos);
  });

  it('стройка за сплошной стеной — строитель переставляется без ходьбы', () => {
    const crew = new BuilderCrew(1);
    crew.sync([th]);
    const b = crew.builders[0]!;
    const tower = building('tower', 0, 0, 1_000);
    const walls = [building('wall', 2, 0), building('wall', 2, 1), building('wall', 2, 2), building('wall', 1, 2), building('wall', 0, 2)];
    crew.sync([th, ...walls, tower]);
    assert.equal(b.state, 'building');
    assert.equal(b.teleports, 1);
  });

  it('улучшение ратуши: строитель работает у неё', () => {
    const crew = new BuilderCrew(2);
    crew.sync([th]);
    crew.sync([{ ...th, finishAt: 1_000 }]);
    walkAll(crew);
    const busy = crew.builders.find((b) => b.targetId === th.id)!;
    assert.equal(busy.state, 'building');
    assert.ok(adjacent(busy.dest!, th, 3));
  });
});
