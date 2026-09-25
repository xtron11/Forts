import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPlacement, type BuildingPlacement } from './base';
import { BASE_GRID_SIZE, STARTING_BUILDINGS } from './buildings';

describe('checkPlacement', () => {
  const base: BuildingPlacement[] = [{ type: 'farm', x: 2, y: 2 }]; // занимает 2..3 × 2..3

  it('разрешает свободное место внутри поля', () => {
    assert.deepEqual(checkPlacement(base, 'tower', 0, 0), { ok: true });
    assert.deepEqual(checkPlacement(base, 'farm', 4, 2), { ok: true }); // вплотную справа
    assert.deepEqual(checkPlacement([], 'wall', BASE_GRID_SIZE - 1, BASE_GRID_SIZE - 1), { ok: true });
  });

  it('запрещает пересечение с другим зданием', () => {
    assert.deepEqual(checkPlacement(base, 'tower', 3, 3), { ok: false, reason: 'overlap' });
    assert.deepEqual(checkPlacement(base, 'farm', 1, 1), { ok: false, reason: 'overlap' });
    assert.deepEqual(checkPlacement(base, 'townhall', 0, 0), { ok: false, reason: 'overlap' });
  });

  it('запрещает выход за край поля', () => {
    assert.deepEqual(checkPlacement([], 'tower', -1, 0), { ok: false, reason: 'out_of_bounds' });
    assert.deepEqual(checkPlacement([], 'farm', BASE_GRID_SIZE - 1, 0), { ok: false, reason: 'out_of_bounds' });
    assert.deepEqual(checkPlacement([], 'tower', 0, BASE_GRID_SIZE), { ok: false, reason: 'out_of_bounds' });
  });

  it('отклоняет нецелые и нечисловые координаты', () => {
    assert.deepEqual(checkPlacement([], 'tower', 1.5, 0), { ok: false, reason: 'out_of_bounds' });
    assert.deepEqual(checkPlacement([], 'tower', Number.NaN, 0), { ok: false, reason: 'out_of_bounds' });
  });

  it('отклоняет неизвестный тип', () => {
    assert.deepEqual(checkPlacement([], 'castle', 0, 0), { ok: false, reason: 'unknown_building_type' });
    assert.deepEqual(checkPlacement([], 'toString', 0, 0), { ok: false, reason: 'unknown_building_type' });
  });

  it('не даёт поставить вторую ратушу', () => {
    assert.deepEqual(checkPlacement(STARTING_BUILDINGS, 'townhall', 0, 0), { ok: false, reason: 'limit_reached' });
  });

  it('стартовая база корректна', () => {
    STARTING_BUILDINGS.forEach((b, i) => {
      assert.deepEqual(checkPlacement(STARTING_BUILDINGS.slice(0, i), b.type, b.x, b.y), { ok: true });
    });
  });
});
