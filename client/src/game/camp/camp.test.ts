/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArmyStack, PlacedBuilding } from '@forts/shared';
import { Camp, CAMP_MIN_GAP, CAMP_WANDER_SHARE, type CampUnit } from './Camp';
import { findCampRect, insideRect } from './campArea';

let nextId = 1;
function building(type: PlacedBuilding['type'], x: number, y: number, level = 1): PlacedBuilding {
  return { id: nextId++, type, x, y, level, finishAt: null, collectedAt: 0, stored: 0 };
}

/** Детерминированный генератор для повторяемых тестов. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

// Ратуша в середине поля 14×14, казарма в углу, лагерь 3×3 рядом с ней.
const BASE = [building('townhall', 5, 5), building('barracks', 1, 1), building('camp', 1, 4)];
type Counts = Partial<Record<ArmyStack['troop'], number>>;
const army = (counts: Counts): { troops: ArmyStack[] } => ({
  troops: Object.entries(counts).map(([troop, count]) => ({ troop: troop as ArmyStack['troop'], level: 1, count: count! })),
});

function newCamp(seed = 1): Camp {
  return new Camp(() => 1.3, seeded(seed));
}

describe('findCampRect', () => {
  it('без лагеря площадки нет', () => {
    assert.equal(findCampRect([building('townhall', 5, 5), building('barracks', 1, 1)]), null);
  });

  it('площадка — основание старшего лагеря', () => {
    const rect = findCampRect([...BASE, building('camp', 9, 9, 3)])!;
    assert.deepEqual(rect, { x: 9, y: 9, w: 3, h: 3 });
    assert.deepEqual(findCampRect(BASE), { x: 1, y: 4, w: 3, h: 3 });
  });
});

describe('Camp', () => {
  it('на площадке по одному юниту каждого войска, число — отдельно', () => {
    const camp = newCamp();
    camp.sync(BASE, army({ warrior: 12, archer: 3, ram: 1 }));
    assert.equal(camp.units.length, 3);
    assert.deepEqual(camp.units.map((u) => u.troop).sort(), ['archer', 'ram', 'warrior']);
    assert.equal(camp.counts.get('warrior'), 12);
    for (const u of camp.units) {
      assert.equal(u.state, 'idle');
      assert.ok(insideRect(camp.rect!, u));
    }
  });

  it('новое войско появляется у казармы и идёт в лагерь; ещё один того же — без нового юнита', () => {
    const camp = newCamp();
    camp.sync(BASE, army({ warrior: 2 }));
    camp.sync(BASE, army({ warrior: 3 }));
    assert.equal(camp.units.length, 1);
    camp.sync(BASE, army({ warrior: 3, archer: 1 }));
    const fresh = camp.units[1]!;
    assert.equal(fresh.troop, 'archer');
    assert.equal(fresh.state, 'arriving');
    // У казармы (клетки 1..2), а не в лагере.
    assert.ok(fresh.col >= 0.5 && fresh.col <= 3.5 && fresh.row >= 0.5 && fresh.row <= 3.5);
    for (let i = 0; i < 400 && fresh.state === 'arriving'; i++) camp.update(50);
    assert.equal(fresh.state, 'idle');
    assert.ok(insideRect(camp.rect!, fresh));
  });

  it('войско, целиком ушедшее в бой, исчезает из лагеря', () => {
    const camp = newCamp();
    camp.sync(BASE, army({ warrior: 5, archer: 2 }));
    camp.sync(BASE, army({ warrior: 1 }));
    assert.deepEqual(
      camp.units.map((u) => u.troop),
      ['warrior'],
    );
    camp.sync(BASE, army({}));
    assert.equal(camp.units.length, 0);
  });

  it('гуляет не больше одного из трёх, цели внутри лагеря и не ближе клетки к другим', () => {
    const camp = newCamp(7);
    camp.sync(BASE, army({ warrior: 9, archer: 4, ram: 2 }));
    const limit = Math.max(1, Math.floor(3 * CAMP_WANDER_SHARE));
    const targets = new Map<CampUnit, unknown>();
    let walks = 0;
    for (let i = 0; i < 4000; i++) {
      camp.update(50);
      const wandering = camp.units.filter((u) => u.state === 'wandering');
      assert.ok(wandering.length <= limit, `гуляет ${wandering.length}`);
      for (const u of wandering) {
        if (targets.get(u) === u.target) continue;
        targets.set(u, u.target);
        walks++;
        for (const o of camp.units) {
          if (o !== u) assert.ok(Math.hypot(o.col - u.target!.col, o.row - u.target!.row) >= CAMP_MIN_GAP);
        }
        assert.ok(insideRect(camp.rect!, u.target!));
      }
      for (const u of camp.units) if (u.state !== 'wandering') targets.delete(u);
    }
    assert.ok(walks > 5, `прогулок ${walks}`);
  });

  it('дойдя до точки, стоит лицом туда, куда шёл', () => {
    const camp = newCamp(3);
    camp.sync(BASE, army({ warrior: 1 }));
    camp.sync(BASE, army({ warrior: 1, archer: 1 }));
    const fresh = camp.units[1]!;
    let lastDir = fresh.dir;
    for (let i = 0; i < 400 && fresh.state === 'arriving'; i++) {
      lastDir = fresh.dir;
      camp.update(50);
    }
    assert.equal(fresh.state, 'idle');
    assert.equal(fresh.dir, lastDir);
  });

  it('таймеры стоят, пока юнит за экраном', () => {
    const camp = newCamp();
    camp.sync(BASE, army({ warrior: 3, archer: 1 }));
    const before = camp.units.map((u) => u.idleLeft);
    camp.update(20_000, () => false);
    assert.deepEqual(
      camp.units.map((u) => u.idleLeft),
      before,
    );
  });

  it('лагерь перенесли — юниты идут на новое место', () => {
    const camp = newCamp();
    camp.sync(BASE, army({ warrior: 4, archer: 2 }));
    const moved = BASE.map((b) => (b.type === 'camp' ? { ...b, x: 9, y: 9 } : b));
    camp.sync(moved, army({ warrior: 4, archer: 2 }));
    assert.deepEqual(camp.rect, { x: 9, y: 9, w: 3, h: 3 });
    for (let i = 0; i < 1000; i++) camp.update(50);
    for (const u of camp.units) assert.ok(insideRect(camp.rect!, u));
  });
});
