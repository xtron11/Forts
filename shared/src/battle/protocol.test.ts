import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArmyStack } from '../army';
import { BUILDING_TYPES } from '../buildings';
import { buildingLimit } from '../economy';
import { BOT_TEMPLATES, botTemplatesFor, generateBotBase, parseLayout } from './bots';
import { BATTLE_MARGIN, BATTLE_MAX_TICKS } from './config';
import { addDeployment, battleResult, createBattle, simulate, stepBattle } from './engine';
import { Rng } from './math';
import { checkOrders, type DeployOrder } from './orders';
import { canDeployAt, maxLoot, normalizeBase } from './snapshot';
import type { BattleBase } from './types';

describe('базы-боты', () => {
  it('шаблонов 10–15, на каждый уровень ратуши 1..5 есть цели ±1', () => {
    assert.ok(BOT_TEMPLATES.length >= 10 && BOT_TEMPLATES.length <= 15);
    assert.equal(new Set(BOT_TEMPLATES.map((t) => t.id)).size, BOT_TEMPLATES.length);
    for (let th = 1; th <= 5; th++) {
      const list = botTemplatesFor(th);
      assert.ok(list.length >= 2, `ратуша ${th}`);
      assert.ok(list.every((t) => Math.abs(t.townhallLevel - th) <= 1));
    }
  });

  it('шаблоны соблюдают лимиты своей ратуши и дают корректную базу при любом seed', () => {
    for (const t of BOT_TEMPLATES) {
      const layout = parseLayout(t.layout);
      for (const type of BUILDING_TYPES) {
        const count = layout.filter((b) => b.type === type).length;
        assert.ok(count <= buildingLimit(type, t.townhallLevel), `${t.id}: ${type} ${count}`);
      }
      assert.equal(layout.filter((b) => b.type === 'townhall').length, 1, t.id);
      for (let seed = 0; seed < 40; seed++) {
        const base = generateBotBase(t, seed);
        assert.doesNotThrow(() => normalizeBase(base), `${t.id} seed ${seed}`);
        assert.equal(base.buildings.length, layout.length);
        // Вокруг базы всегда есть где высадиться.
        assert.equal(canDeployAt(base, -BATTLE_MARGIN, -BATTLE_MARGIN), null);
      }
    }
  });

  it('генератор детерминирован и варьирует шаблон', () => {
    const t = BOT_TEMPLATES[5]!;
    assert.deepEqual(generateBotBase(t, 42), generateBotBase(t, 42));
    const variants = new Set<string>();
    for (let seed = 0; seed < 30; seed++) variants.add(JSON.stringify(generateBotBase(t, seed)));
    assert.ok(variants.size > 20);
    const layouts = new Set<string>();
    for (let seed = 0; seed < 30; seed++) layouts.add(JSON.stringify(generateBotBase(t, seed).buildings.map((b) => [b.x, b.y])));
    assert.ok(layouts.size >= 4, 'повороты и отражения');
  });

  it('возможная добыча — 20% хранилища и 50% накопленного', () => {
    const base: BattleBase = {
      gridSize: 12,
      resources: { gold: 1001, food: 500 },
      buildings: [
        { id: 1, type: 'townhall', level: 1, x: 0, y: 0 },
        { id: 2, type: 'goldmine', level: 1, x: 5, y: 5, stored: 301 },
        { id: 3, type: 'farm', level: 1, x: 8, y: 8, stored: 100 },
      ],
    };
    assert.deepEqual(maxLoot(base), { gold: 200 + 150, food: 100 + 50 });
  });
});

const base = generateBotBase(BOT_TEMPLATES[2]!, 7);
const army: ArmyStack[] = [
  { troop: 'warrior', level: 1, count: 3 },
  { troop: 'warrior', level: 2, count: 1 },
  { troop: 'archer', level: 1, count: 2 },
];
const edge = -BATTLE_MARGIN;

describe('высадки игрока', () => {
  it('уровни назначаются из армии, сначала старшие', () => {
    const orders: DeployOrder[] = [
      { tick: 0, troop: 'warrior', x: edge, y: 0 },
      { tick: 5, troop: 'warrior', x: edge, y: 1 },
      { tick: 5, troop: 'archer', x: edge, y: 2 },
    ];
    const check = checkOrders(base, army, orders);
    assert.ok(check.ok);
    assert.deepEqual(
      check.deployments.map((d) => [d.troop, d.level]),
      [
        ['warrior', 2],
        ['warrior', 1],
        ['archer', 1],
      ],
    );
    assert.equal(check.allTroopsUsed, false);
  });

  it('лишние войска, запрещённая зона, тики за лимитом и не по порядку — отказ', () => {
    const w = (tick: number, x = edge, y = 0): DeployOrder => ({ tick, troop: 'warrior', x, y });
    assert.deepEqual(checkOrders(base, army, [w(0), w(0), w(0), w(0), w(1)]), { ok: false, reason: 'not_enough_troops', index: 4 });
    assert.deepEqual(checkOrders(base, army, [{ tick: 0, troop: 'ram', x: edge, y: 0 }]), { ok: false, reason: 'not_enough_troops', index: 0 });
    assert.deepEqual(checkOrders(base, army, [w(0), w(3, 6, 6)]), { ok: false, reason: 'forbidden_zone', index: 1 });
    assert.deepEqual(checkOrders(base, army, [w(BATTLE_MAX_TICKS)]), { ok: false, reason: 'invalid_tick', index: 0 });
    assert.deepEqual(checkOrders(base, army, [w(-1)]), { ok: false, reason: 'invalid_tick', index: 0 });
    assert.deepEqual(checkOrders(base, army, [w(10)], 10), { ok: false, reason: 'invalid_tick', index: 0 });
    assert.deepEqual(checkOrders(base, army, [w(10), w(9)]), { ok: false, reason: 'ticks_not_sorted', index: 1 });
    assert.deepEqual(checkOrders(base, army, [w(0, edge - 1)]), { ok: false, reason: 'out_of_bounds', index: 0 });
  });
});

/** Случайные высадки по краю поля: n юнитов из армии, тики не убывают. */
function randomOrders(rng: Rng, stock: ArmyStack[], n: number, maxTick: number): DeployOrder[] {
  const pool = stock.flatMap((s) => Array.from({ length: s.count }, () => s.troop));
  const orders: DeployOrder[] = [];
  let tick = 0;
  for (let i = 0; i < n && pool.length > 0; i++) {
    tick = Math.min(maxTick, tick + rng.int(40));
    const troop = pool.splice(rng.int(pool.length), 1)[0]!;
    const side = rng.int(4);
    const pos = rng.int(12);
    const [x, y] = side === 0 ? [edge, pos] : side === 1 ? [11 + BATTLE_MARGIN, pos] : side === 2 ? [pos, edge] : [pos, 11 + BATTLE_MARGIN];
    orders.push({ tick, troop, x, y });
  }
  return orders;
}

/** Бой вживую, как в клиенте: высадки на своём тике, сдача на endTick или естественный конец. */
function playLive(b: BattleBase, stock: ArmyStack[], orders: DeployOrder[], seed: number, surrenderAt?: number) {
  const created = createBattle(b, [], seed, { endWhenNoTroops: false });
  assert.ok(created.ok);
  const s = created.state;
  const check = checkOrders(b, stock, orders);
  assert.ok(check.ok);
  let next = 0;
  while (!s.finished && (surrenderAt === undefined || s.tick < surrenderAt)) {
    while (next < check.deployments.length && check.deployments[next]!.tick === s.tick) {
      assert.ok(addDeployment(s, check.deployments[next]!).ok);
      next++;
      if (next === check.deployments.length && check.allTroopsUsed) s.endWhenNoTroops = true;
    }
    stepBattle(s);
  }
  // Бой мог кончиться раньше, чем игрок высадил всё: на сервер уходят только сделанные высадки.
  const allUsed = check.allTroopsUsed && next === check.deployments.length;
  return { endTick: s.tick, result: battleResult(s), allUsed, deployments: check.deployments.slice(0, next) };
}

describe('живой бой совпадает с simulate', () => {
  const stock: ArmyStack[] = [
    { troop: 'warrior', level: 1, count: 12 },
    { troop: 'archer', level: 1, count: 8 },
    { troop: 'ram', level: 1, count: 2 },
  ];

  it('вся армия или бой кончился раньше — один и тот же итог', () => {
    let allUsed = 0;
    for (let seed = 1; seed <= 15; seed++) {
      const rng = new Rng(seed * 7919);
      const b = generateBotBase(BOT_TEMPLATES[seed % BOT_TEMPLATES.length]!, seed);
      const orders = randomOrders(rng, stock, 22, 600);
      const live = playLive(b, stock, orders, seed);
      const server = simulate(b, live.deployments, seed, live.endTick, { endWhenNoTroops: live.allUsed });
      assert.ok(server.ok);
      assert.deepEqual(server.result, live.result, `seed ${seed}`);
      if (live.allUsed) allUsed++;
    }
    // Есть и бои, где высажена вся армия и конец — гибель всех юнитов.
    assert.ok(allUsed > 0);
  });

  it('часть армии и сдача на произвольном тике', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rng = new Rng(seed * 104729);
      const b = generateBotBase(BOT_TEMPLATES[(seed * 3) % BOT_TEMPLATES.length]!, seed);
      const orders = randomOrders(rng, stock, 6, 300);
      const surrender = 350 + rng.int(800);
      const live = playLive(b, stock, orders, seed, surrender);
      assert.equal(live.allUsed, false);
      const server = simulate(b, live.deployments, seed, live.endTick, { endWhenNoTroops: live.allUsed });
      assert.ok(server.ok);
      assert.deepEqual(server.result, live.result, `seed ${seed}`);
    }
  });

  it('высадку не на текущем тике движок отклоняет', () => {
    const created = createBattle(base, [], 1, { endWhenNoTroops: false });
    assert.ok(created.ok);
    stepBattle(created.state);
    assert.deepEqual(addDeployment(created.state, { troop: 'warrior', level: 1, x: edge, y: 0, tick: 0 }), {
      ok: false,
      reason: 'invalid_tick',
      index: 0,
    });
    assert.equal(addDeployment(created.state, { troop: 'warrior', level: 1, x: 6, y: 6, tick: 1 }).ok, false);
    assert.ok(addDeployment(created.state, { troop: 'warrior', level: 1, x: edge, y: 0, tick: 1 }).ok);
  });
});
