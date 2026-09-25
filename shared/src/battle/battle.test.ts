import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { producerLevel } from '../balance';
import type { BuildingType } from '../buildings';
import type { TroopType } from '../troops';
import { BATTLE_MAX_TICKS, LOOT_PRODUCER_PERCENT, LOOT_STORAGE_PERCENT } from './config';
import { battleResult, createBattle, simulate, stepBattle, type SimulateOutcome } from './engine';
import { battleBaseFromPlayer } from './snapshot';
import type { BattleBase, BattleBuilding, BattleEvent, Deployment } from './types';

let nextId = 1;
function b(type: BuildingType, x: number, y: number, level = 1, stored = 0): BattleBuilding {
  return { id: nextId++, type, level, x, y, stored };
}

function base(buildings: BattleBuilding[], resources = { gold: 0, food: 0 }): BattleBase {
  return { gridSize: 12, resources, buildings };
}

function deploy(troop: TroopType, x: number, y: number, tick = 0, level = 1): Deployment {
  return { troop, level, x, y, tick };
}

function run(bs: BattleBase, deployments: Deployment[], seed = 1, untilTick?: number) {
  const out = simulate(bs, deployments, seed, untilTick, { log: true });
  assert.ok(out.ok, `высадка отклонена: ${JSON.stringify(out)}`);
  return { ...out.result, log: out.log! };
}

function events<K extends BattleEvent['kind']>(log: BattleEvent[], kind: K): Extract<BattleEvent, { kind: K }>[] {
  return log.filter((e): e is Extract<BattleEvent, { kind: K }> => e.kind === kind);
}

/** Стены по линии от (x0, y0) до (x1, y1) включительно (горизонталь или вертикаль). */
function wallLine(x0: number, y0: number, x1: number, y1: number): BattleBuilding[] {
  const walls: BattleBuilding[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) walls.push(b('wall', x, y));
  return walls;
}

/** Кольцо стен по периметру прямоугольника. */
function wallRing(x0: number, y0: number, x1: number, y1: number): BattleBuilding[] {
  return [...wallLine(x0, y0, x1, y0), ...wallLine(x0, y1, x1, y1), ...wallLine(x0, y0 + 1, x0, y1 - 1), ...wallLine(x1, y0 + 1, x1, y1 - 1)];
}

/** Типичная база: ратуша, шахты, фермы, казарма, башни, стены. */
function sampleBase(): BattleBase {
  nextId = 100;
  return base(
    [
      b('townhall', 5, 5, 2),
      b('goldmine', 1, 1, 2, 800),
      b('farm', 9, 1, 1, 300),
      b('goldmine', 1, 9),
      b('farm', 9, 9, 1, 120),
      b('barracks', 5, 1),
      b('tower', 3, 5, 2),
      b('tower', 8, 6),
      ...wallLine(4, 4, 8, 4),
      ...wallLine(4, 8, 8, 8),
    ],
    { gold: 1234, food: 777 },
  );
}

function sampleArmy(): Deployment[] {
  const d: Deployment[] = [];
  for (let i = 0; i < 12; i++) d.push(deploy('warrior', -3, i, i * 3));
  for (let i = 0; i < 8; i++) d.push(deploy('archer', 14, i + 2, 20 + i * 5));
  d.push(deploy('ram', 5, -3, 5), deploy('ram', 6, 14, 40));
  return d;
}

/** Та же структура, ключи объектов в обратном порядке. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)])) as T;
  }
  return value;
}

describe('бой: детерминизм', () => {
  it('один и тот же вход 1000 раз — одинаковый хэш', () => {
    const bs = sampleBase();
    const army = sampleArmy();
    const first = simulate(bs, army, 12345);
    assert.ok(first.ok);
    assert.ok(first.result.finished);
    for (let i = 0; i < 1000; i++) {
      const again = simulate(bs, army, 12345);
      assert.ok(again.ok);
      assert.equal(again.result.hash, first.result.hash, `прогон ${i}`);
    }
  });

  it('другой порядок ключей во входных объектах и зданий в массиве — тот же результат', () => {
    const bs = sampleBase();
    const army = sampleArmy();
    const a = simulate(bs, army, 777) as Extract<SimulateOutcome, { ok: true }>;
    const reversed = reverseKeys(bs);
    reversed.buildings.reverse();
    const c = simulate(reversed, reverseKeys(army), 777) as Extract<SimulateOutcome, { ok: true }>;
    assert.ok(a.ok && c.ok);
    assert.deepEqual(c.result, a.result);
  });

  it('seed влияет на ход боя', () => {
    const r1 = run(sampleBase(), sampleArmy(), 1);
    const r2 = run(sampleBase(), sampleArmy(), 2);
    assert.notEqual(r1.hash, r2.hash);
  });

  it('untilTick останавливает бой, пошаговый прогон совпадает с simulate', () => {
    const bs = sampleBase();
    const army = sampleArmy();
    const partial = run(bs, army, 5, 300);
    assert.equal(partial.finished, false);
    assert.equal(partial.endTick, 300);

    const created = createBattle(bs, army, 5);
    assert.ok(created.ok);
    while (created.state.tick < 300) stepBattle(created.state);
    const { log: _log, ...partialResult } = partial;
    assert.deepEqual(battleResult(created.state), partialResult);
  });
});

describe('бой: путь и стены', () => {
  it('воин обходит короткую стену, а не ломает её', () => {
    nextId = 1;
    const farm = b('farm', 6, 5);
    const walls = wallLine(3, 5, 3, 6);
    const r = run(base([farm, ...walls]), [deploy('warrior', 0, 5)]);
    assert.equal(r.destruction, 100);
    const wallIds = new Set(walls.map((w) => w.id));
    assert.deepEqual(events(r.log, 'hit').filter((e) => wallIds.has(e.building)), []);
  });

  it('воин пробивает стену, если цель окружена', () => {
    nextId = 1;
    const farm = b('farm', 5, 5);
    const walls = wallRing(3, 3, 8, 8);
    const r = run(base([farm, ...walls]), [deploy('warrior', 0, 5)]);
    assert.equal(r.destruction, 100);
    const wallIds = new Set(walls.map((w) => w.id));
    const wallHits = events(r.log, 'hit').filter((e) => wallIds.has(e.building));
    assert.ok(wallHits.length > 0);
    // Сломана ровно одна стена — дальше воин идёт в пролом.
    assert.equal(events(r.log, 'destroyed').filter((e) => wallIds.has(e.building)).length, 1);
  });

  it('лучник стреляет через стену и её не трогает', () => {
    nextId = 1;
    const farm = b('farm', 5, 5);
    const walls = wallRing(3, 3, 8, 8);
    const r = run(base([farm, ...walls]), [deploy('archer', 0, 5)]);
    assert.equal(r.destruction, 100);
    const wallIds = new Set(walls.map((w) => w.id));
    assert.deepEqual(events(r.log, 'hit').filter((e) => wallIds.has(e.building)), []);
  });

  it('таран выбирает оборону, а не ближайшее здание', () => {
    nextId = 1;
    const farm = b('farm', 2, 5);
    const tower = b('tower', 9, 5);
    const r = run(base([farm, tower]), [deploy('ram', -3, 5)], 1, 20);
    assert.deepEqual(events(r.log, 'target')[0], { tick: 0, kind: 'target', unit: 0, building: tower.id });
  });

  it('таран ломает стену там, где воин её обходит', () => {
    nextId = 1;
    const tower = b('tower', 6, 5, 1);
    const walls = wallLine(3, 4, 3, 7);
    const wallIds = new Set(walls.map((w) => w.id));
    const ram = run(base([tower, ...walls]), [deploy('ram', 0, 5)]);
    assert.ok(events(ram.log, 'hit').some((e) => wallIds.has(e.building)), 'таран бьёт стену');

    const warriors = run(base([tower, ...walls]), [0, 1, 2, 3, 4].map(() => deploy('warrior', 0, 5)));
    assert.deepEqual(events(warriors.log, 'hit').filter((e) => wallIds.has(e.building)), [], 'воины обходят');
  });

  it('без обороны таран идёт к стенам', () => {
    nextId = 1;
    const th = b('townhall', 5, 5);
    const walls = wallRing(3, 3, 9, 9);
    const r = run(base([th, ...walls]), [deploy('ram', 0, 6)], 1, 5);
    const first = events(r.log, 'target')[0]!;
    assert.ok(walls.some((w) => w.id === first.building));
  });
});

describe('бой: башня', () => {
  it('башня убивает одиночного воина', () => {
    nextId = 1;
    const r = run(base([b('tower', 5, 5)]), [deploy('warrior', 0, 5)]);
    assert.equal(r.finished, true);
    assert.ok(r.endTick < BATTLE_MAX_TICKS);
    assert.equal(r.destruction, 0);
    assert.equal(r.stars, 0);
    assert.deepEqual(r.troopsUsed, [{ troop: 'warrior', level: 1, count: 1 }]);
    assert.deepEqual(r.troopsSurvived, []);
  });

  it('толпа воинов сносит башню', () => {
    nextId = 1;
    const crowd = Array.from({ length: 20 }, (_, i) => deploy('warrior', 0, 3 + (i % 5)));
    const r = run(base([b('tower', 5, 5)]), crowd);
    assert.equal(r.destruction, 100);
    assert.equal(r.stars, 2); // 50% и 100%; ратуши нет
    assert.ok(r.troopsSurvived.length > 0);
  });
});

describe('бой: высадка', () => {
  it('высадка ближе разрешённого к зданию отклоняется', () => {
    nextId = 1;
    const bs = base([b('townhall', 5, 5)]);
    const out = simulate(bs, [deploy('warrior', 0, 0), deploy('warrior', 4, 5)], 1);
    assert.deepEqual(out, { ok: false, reason: 'forbidden_zone', index: 1 });
    // Вплотную к стене — тоже нельзя.
    const walled = base([b('wall', 0, 0)]);
    assert.deepEqual(simulate(walled, [deploy('warrior', -2, 0)], 1), { ok: false, reason: 'forbidden_zone', index: 0 });
    assert.ok(simulate(walled, [deploy('warrior', -3, 0)], 1).ok);
  });

  it('за краем поля, неверный тик, войско и уровень — отказ', () => {
    nextId = 1;
    const bs = base([b('townhall', 5, 5)]);
    assert.deepEqual(simulate(bs, [deploy('warrior', -5, 0)], 1), { ok: false, reason: 'out_of_bounds', index: 0 });
    assert.deepEqual(simulate(bs, [deploy('warrior', 0.5, 0)], 1), { ok: false, reason: 'out_of_bounds', index: 0 });
    assert.deepEqual(simulate(bs, [deploy('warrior', 0, 0, BATTLE_MAX_TICKS)], 1), { ok: false, reason: 'invalid_tick', index: 0 });
    assert.deepEqual(simulate(bs, [deploy('warrior', 0, 0, 0, 99)], 1), { ok: false, reason: 'invalid_level', index: 0 });
    assert.deepEqual(simulate(bs, [{ ...deploy('warrior', 0, 0), troop: 'dragon' as TroopType }], 1), {
      ok: false,
      reason: 'unknown_troop',
      index: 0,
    });
  });
});

describe('бой: результат', () => {
  it('полное разрушение: 3 звезды и вся добыча', () => {
    nextId = 1;
    const resources = { gold: 1000, food: 501 };
    const bs = base([b('townhall', 5, 5), b('goldmine', 1, 1, 1, 333), b('farm', 9, 9, 1, 100), ...wallLine(0, 11, 3, 11)], resources);
    const crowd = Array.from({ length: 30 }, (_, i) => deploy('warrior', -3, i % 12));
    const r = run(bs, crowd);
    assert.equal(r.destruction, 100);
    assert.equal(r.stars, 3);
    assert.equal(r.townhallDestroyed, true);
    const storage = (n: number) => Math.trunc((n * LOOT_STORAGE_PERCENT) / 100);
    const prod = (n: number) => Math.trunc((n * LOOT_PRODUCER_PERCENT) / 100);
    assert.deepEqual(r.loot, { gold: storage(1000) + prod(333), food: storage(501) + prod(100) });
    // Сумма добычи по событиям равна итогу.
    const sum = events(r.log, 'destroyed').reduce((acc, e) => ({ gold: acc.gold + e.loot.gold, food: acc.food + e.loot.food }), { gold: 0, food: 0 });
    assert.deepEqual(sum, r.loot);
  });

  it('ратуша без 50% — одна звезда; добыча пропорциональна разрушенным', () => {
    nextId = 1;
    const th = b('townhall', 0, 0);
    const bs = base([th, b('farm', 9, 9), b('farm', 9, 6), b('barracks', 6, 9)], { gold: 1000, food: 0 });
    const r = run(bs, Array.from({ length: 10 }, () => deploy('warrior', -3, 0)), 1);
    // Воины сносят ратушу, затем идут дальше; остановим бой, когда она пала.
    const thDown = events(r.log, 'destroyed').find((e) => e.building === th.id)!;
    const partial = run(bs, Array.from({ length: 10 }, () => deploy('warrior', -3, 0)), 1, thDown.tick + 1);
    assert.equal(partial.destruction, 25);
    assert.equal(partial.stars, 1);
    assert.deepEqual(partial.loot, { gold: Math.floor((200 * 1) / 4), food: 0 });
  });

  it('снимок реальной базы: накопленное в шахтах — к моменту боя', () => {
    const t0 = 1_000_000;
    const mine = { id: 7, type: 'goldmine' as const, x: 0, y: 0, level: 1, finishAt: null, collectedAt: t0, stored: 0 };
    const building = { id: 3, type: 'barracks' as const, x: 4, y: 4, level: 0, finishAt: t0 + 10_000_000, collectedAt: t0, stored: 0 };
    const snap = battleBaseFromPlayer([mine, building], { gold: 5, food: 6 }, t0 + 3_600_000);
    assert.deepEqual(snap.buildings, [
      { id: 3, type: 'barracks', level: 1, x: 4, y: 4, stored: 0 },
      { id: 7, type: 'goldmine', level: 1, x: 0, y: 0, stored: Math.min(producerLevel('goldmine', 1)!.capacity, producerLevel('goldmine', 1)!.perHour) },
    ]);
  });
});

describe('бой: производительность', () => {
  it('3 минуты, 60 юнитов против 30 зданий — быстрее 200 мс', () => {
    nextId = 1;
    const buildings: BattleBuilding[] = [
      b('townhall', 5, 5, 5),
      b('goldmine', 0, 0, 6),
      b('goldmine', 2, 0, 6),
      b('farm', 8, 0, 6),
      b('farm', 10, 0, 6),
      b('goldmine', 0, 10, 6),
      b('farm', 10, 10, 6),
      b('barracks', 0, 5, 4),
      b('barracks', 10, 5, 4),
      b('tower', 2, 3, 3),
      b('tower', 10, 3, 3),
      b('tower', 2, 9, 3),
      b('tower', 10, 8, 3),
      ...wallLine(4, 4, 8, 4),
      ...wallLine(4, 8, 8, 8),
      ...wallLine(4, 5, 4, 7),
      ...wallLine(8, 5, 8, 7),
    ];
    // Ровно 30: добиваем стенами у края.
    buildings.push(...wallLine(5, 10, 5 + (30 - buildings.length) - 1, 10));
    assert.equal(buildings.length, 30);
    const bs = base(buildings);
    // Шесть волн по 10 юнитов с разных сторон каждые 30 с — бой идёт все 3 минуты.
    const troops: TroopType[] = ['warrior', 'warrior', 'archer', 'archer', 'ram'];
    const army = Array.from({ length: 60 }, (_, i) => {
      const wave = Math.floor(i / 10);
      const troop = troops[i % troops.length]!;
      const side = wave % 4;
      const pos = (i * 5) % 12;
      const [x, y] = side === 0 ? [-3, pos] : side === 1 ? [14, pos] : side === 2 ? [pos, -3] : [pos, 14];
      return deploy(troop, x, y, wave * 300 + (i % 10));
    });

    const times: number[] = [];
    let result;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      result = simulate(bs, army, 99);
      times.push(performance.now() - start);
    }
    assert.ok(result?.ok);
    assert.equal(result.result.endTick, BATTLE_MAX_TICKS, 'бой должен идти все 3 минуты');
    times.sort((a, b) => a - b);
    const median = times[2]!;
    console.log(`  бенчмарк: медиана ${median.toFixed(1)} мс, худший ${times[4]!.toFixed(1)} мс`);
    assert.ok(median < 200, `медиана ${median.toFixed(1)} мс`);
  });
});
