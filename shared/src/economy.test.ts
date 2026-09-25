import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILDER_COUNT,
  BUILDING_LEVELS,
  MAX_TOWNHALL_LEVEL,
  PRODUCERS,
  TOWNHALL_LEVELS,
  levelConfig,
  townhallConfig,
} from './balance';
import { BUILDING_TYPES, type BuildingType } from './buildings';
import {
  accumulated,
  busyBuilders,
  checkBuild,
  checkUpgrade,
  collect,
  fillTime,
  isCollectReady,
  newBuildingState,
  settleBuilding,
  startUpgrade,
  storageCapacity,
  townhallLevel,
  type BuildingState,
} from './economy';
import { RESOURCE_TYPES, STARTING_RESOURCES, type Resources } from './resources';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function ready(type: BuildingType, level = 1, collectedAt = T0, stored = 0): BuildingState {
  return { type, level, finishAt: null, collectedAt, stored };
}

const mine1 = PRODUCERS.goldmine.levels[0]!;
const RICH: Resources = { gold: 1_000_000, food: 1_000_000 };

describe('баланс', () => {
  it('у каждого здания есть уровни с положительным HP, требования ратуши не выше максимума', () => {
    for (const type of BUILDING_TYPES) {
      const levels = BUILDING_LEVELS[type];
      assert.ok(levels.length > 0, type);
      for (const l of levels) {
        assert.ok(l.hp > 0 && l.buildSeconds >= 0, type);
        assert.ok(l.townhallLevel <= MAX_TOWNHALL_LEVEL, type);
      }
    }
  });

  it('любой уровень можно оплатить: цена влезает в хранилище ратуши нужного уровня', () => {
    for (const type of BUILDING_TYPES) {
      BUILDING_LEVELS[type].forEach((l, i) => {
        const storage = townhallConfig(Math.max(1, l.townhallLevel))!.storage;
        for (const r of RESOURCE_TYPES) assert.ok(l.cost[r] <= storage[r], `${type} ур. ${i + 1}: ${r}`);
      });
    }
  });

  it('здание открывается на том уровне ратуши, где его лимит становится больше нуля', () => {
    for (const type of BUILDING_TYPES) {
      const th = Math.max(1, levelConfig(type, 1)!.townhallLevel);
      assert.ok(townhallConfig(th)!.limits[type] > 0, type);
      if (th > 1) assert.equal(townhallConfig(th - 1)!.limits[type], 0, type);
    }
  });

  it('темп: первые постройки — секунды, ратуша 5 — часы', () => {
    assert.ok(levelConfig('goldmine', 1)!.buildSeconds < 60);
    assert.ok(levelConfig('farm', 1)!.buildSeconds < 60);
    assert.ok(TOWNHALL_LEVELS[4]!.buildSeconds >= 3600);
  });

  it('стартовый запас влезает в хранилище ратуши 1', () => {
    for (const r of RESOURCE_TYPES) assert.ok(STARTING_RESOURCES[r] <= townhallConfig(1)!.storage[r]);
  });
});

describe('накопление', () => {
  it('растёт линейно от времени последнего сбора', () => {
    const b = ready('goldmine');
    assert.equal(accumulated(b, T0), 0);
    assert.equal(accumulated(b, T0 + 10 * MIN), Math.floor(mine1.perHour / 6));
    assert.equal(accumulated(b, T0 + 30 * MIN), Math.floor(mine1.perHour / 2));
  });

  it('не превышает вместимость здания', () => {
    const b = ready('goldmine');
    assert.equal(accumulated(b, T0 + 100 * HOUR), mine1.capacity);
    const lvl3 = PRODUCERS.farm.levels[2]!;
    assert.equal(accumulated(ready('farm', 3), T0 + 100 * HOUR), lvl3.capacity);
  });

  it('учитывает уровень здания и остаток от прошлого сбора', () => {
    const lvl2 = PRODUCERS.goldmine.levels[1]!;
    assert.equal(accumulated(ready('goldmine', 2, T0, 100), T0 + HOUR), 100 + lvl2.perHour);
  });

  it('время из прошлого (часы назад) не даёт отрицательных значений', () => {
    assert.equal(accumulated(ready('goldmine'), T0 - HOUR), 0);
  });

  it('у зданий без добычи всегда 0', () => {
    assert.equal(accumulated(ready('barracks'), T0 + HOUR), 0);
    assert.equal(accumulated(ready('townhall'), T0 + HOUR), 0);
  });

  it('не идёт, пока здание строится, и начинается ровно с finishAt', () => {
    const b = { type: 'goldmine' as const, ...newBuildingState('goldmine', T0) };
    const finish = T0 + mine1.buildSeconds * SEC;
    assert.equal(b.level, 0);
    assert.equal(b.finishAt, finish);
    assert.equal(accumulated(b, finish - 1), 0);
    assert.equal(accumulated(b, finish), 0);
    assert.equal(accumulated(b, finish + HOUR), mine1.perHour);
  });

  it('замирает на время улучшения и продолжается после', () => {
    const lvl2 = PRODUCERS.goldmine.levels[1]!;
    const b = startUpgrade(ready('goldmine'), T0 + 30 * MIN);
    const before = Math.floor(mine1.perHour / 2);
    assert.equal(b.stored, before);
    assert.equal(accumulated(b, T0 + 30 * MIN + lvl2.buildSeconds * SEC - 1), before);
    const done = T0 + 30 * MIN + lvl2.buildSeconds * SEC;
    assert.equal(accumulated(b, done), before);
    assert.equal(accumulated(b, done + HOUR), before + lvl2.perHour);
  });

  it('значок сбора появляется с 5% вместимости', () => {
    const b = ready('goldmine');
    const threshold = Math.ceil(mine1.capacity * 0.05);
    const msToThreshold = Math.ceil((threshold * HOUR) / mine1.perHour);
    assert.equal(isCollectReady(b, T0 + msToThreshold - SEC), false);
    assert.equal(isCollectReady(b, T0 + msToThreshold), true);
  });
});

describe('стройка', () => {
  it('завершается ровно в finishAt', () => {
    const b = { type: 'farm' as const, ...newBuildingState('farm', T0) };
    const finish = b.finishAt!;
    assert.equal(settleBuilding(b, finish - 1), b);
    assert.deepEqual(settleBuilding(b, finish), { ...b, level: 1, finishAt: null, collectedAt: finish });
  });

  it('стены готовы сразу', () => {
    assert.deepEqual(newBuildingState('wall', T0), { level: 1, finishAt: null, collectedAt: T0, stored: 0 });
  });

  it('улучшение ратуши повышает хранилище только по завершении', () => {
    const th = startUpgrade(ready('townhall'), T0);
    assert.equal(townhallLevel([th], T0), 1);
    assert.deepEqual(storageCapacity([th], T0), townhallConfig(1)!.storage);
    assert.equal(townhallLevel([th], th.finishAt!), 2);
    assert.deepEqual(storageCapacity([th], th.finishAt!), townhallConfig(2)!.storage);
  });

  it('строители заняты, пока не наступил finishAt', () => {
    const b = { type: 'farm' as const, ...newBuildingState('farm', T0) };
    assert.equal(busyBuilders([b], T0), 1);
    assert.equal(busyBuilders([b], b.finishAt! - 1), 1);
    assert.equal(busyBuilders([b], b.finishAt!), 0);
  });
});

describe('checkBuild', () => {
  const base = [ready('townhall')];

  it('разрешает, когда всё в порядке', () => {
    const check = checkBuild(STARTING_RESOURCES, base, 'goldmine', T0);
    assert.equal(check.ok, true);
  });

  it('нельзя без ресурсов', () => {
    assert.deepEqual(checkBuild({ gold: 1000, food: 0 }, base, 'goldmine', T0), {
      ok: false,
      reason: 'not_enough_resources',
      missing: 'food',
    });
  });

  it('нельзя без свободного строителя', () => {
    const busy = Array.from({ length: BUILDER_COUNT }, () => ({ type: 'farm' as const, ...newBuildingState('farm', T0) }));
    const withBusy = [ready('townhall', 2), ...busy];
    assert.deepEqual(checkBuild(RICH, withBusy, 'goldmine', T0), { ok: false, reason: 'no_free_builder' });
    // Как только одна стройка закончилась — строитель свободен.
    assert.equal(checkBuild(RICH, withBusy, 'goldmine', busy[0]!.finishAt!).ok, true);
  });

  it('мгновенные постройки не требуют строителя', () => {
    const busy = Array.from({ length: BUILDER_COUNT }, () => ({ type: 'farm' as const, ...newBuildingState('farm', T0) }));
    assert.equal(checkBuild(RICH, [ready('townhall', 2), ...busy], 'wall', T0).ok, true);
  });

  it('нельзя без нужного уровня ратуши', () => {
    assert.deepEqual(checkBuild(RICH, base, 'tower', T0), { ok: false, reason: 'townhall_level_too_low', requiredTownhall: 2 });
    assert.equal(checkBuild(RICH, [ready('townhall', 2)], 'tower', T0).ok, true);
  });

  it('нельзя сверх лимита ратуши; подсказывает, какая ратуша нужна', () => {
    const two = [ready('townhall'), ready('goldmine'), ready('goldmine')];
    assert.deepEqual(checkBuild(RICH, two, 'goldmine', T0), { ok: false, reason: 'limit_reached', limit: 2, requiredTownhall: 2 });
    assert.deepEqual(checkBuild(RICH, base, 'townhall', T0), {
      ok: false,
      reason: 'limit_reached',
      limit: 1,
      requiredTownhall: undefined,
    });
  });

  it('здание в стройке тоже считается в лимите', () => {
    const building = [ready('townhall'), ready('barracks', 0)];
    building[1]!.finishAt = T0 + MIN;
    assert.equal(checkBuild(RICH, building, 'barracks', T0).ok, false);
  });

  it('отклоняет неизвестный тип', () => {
    assert.deepEqual(checkBuild(RICH, base, 'castle', T0), { ok: false, reason: 'unknown_building_type' });
  });
});

describe('checkUpgrade', () => {
  it('нельзя улучшать то, что ещё строится', () => {
    const b = startUpgrade(ready('goldmine'), T0);
    assert.deepEqual(checkUpgrade(RICH, [ready('townhall'), b], b, T0), { ok: false, reason: 'under_construction' });
  });

  it('нельзя выше максимального уровня', () => {
    const top = ready('townhall', MAX_TOWNHALL_LEVEL);
    assert.deepEqual(checkUpgrade(RICH, [top], top, T0), { ok: false, reason: 'max_level' });
  });

  it('уровень здания ограничен уровнем ратуши', () => {
    const mine = ready('goldmine', 2);
    assert.deepEqual(checkUpgrade(RICH, [ready('townhall'), mine], mine, T0), {
      ok: false,
      reason: 'townhall_level_too_low',
      requiredTownhall: 2,
    });
    assert.equal(checkUpgrade(RICH, [ready('townhall', 2), mine], mine, T0).ok, true);
  });

  it('ратушу можно улучшать по порядку', () => {
    const th = ready('townhall');
    const check = checkUpgrade(RICH, [th], th, T0);
    assert.ok(check.ok);
    assert.equal(check.level, townhallConfig(2));
  });
});

describe('collect', () => {
  const th = ready('townhall');

  it('переносит накопленное в хранилище и обнуляет здание', () => {
    const mine = ready('goldmine');
    const now = T0 + 10 * MIN;
    const res = collect(mine, { gold: 0, food: 0 }, [th, mine], now)!;
    assert.equal(res.resource, 'gold');
    assert.equal(res.amount, Math.floor(mine1.perHour / 6));
    assert.equal(res.building.stored, 0);
    assert.equal(res.building.collectedAt, now);
    assert.equal(accumulated(res.building, now), 0);
  });

  it('берёт не больше свободного места, остаток остаётся в здании', () => {
    const mine = ready('goldmine');
    const cap = townhallConfig(1)!.storage.gold;
    const now = T0 + HOUR;
    const res = collect(mine, { gold: cap - 50, food: 0 }, [th, mine], now)!;
    assert.equal(res.amount, 50);
    assert.equal(res.building.stored, mine1.perHour - 50);
    assert.equal(accumulated(res.building, now + HOUR), Math.min(mine1.capacity, mine1.perHour * 2 - 50));
  });

  it('при полном хранилище ничего не меняет', () => {
    const mine = ready('goldmine');
    const cap = townhallConfig(1)!.storage.gold;
    const res = collect(mine, { gold: cap, food: 0 }, [th, mine], T0 + HOUR)!;
    assert.equal(res.amount, 0);
    assert.deepEqual(res.building, mine);
  });

  it('у зданий без добычи — undefined', () => {
    assert.equal(collect(th, { gold: 0, food: 0 }, [th], T0 + HOUR), undefined);
  });
});

describe('fillTime — когда шахта/ферма заполнится', () => {
  it('ровно в момент, когда накопленное достигает вместимости', () => {
    for (const type of ['goldmine', 'farm'] as const) {
      for (let level = 1; level <= PRODUCERS[type].levels.length; level++) {
        const b = ready(type, level, T0, 7);
        const at = fillTime(b)!;
        const cap = PRODUCERS[type].levels[level - 1]!.capacity;
        assert.equal(accumulated(b, at), cap, `${type} ${level}`);
        assert.ok(accumulated(b, at - 1) < cap, `${type} ${level}: на миллисекунду раньше ещё не полна`);
      }
    }
  });

  it('шахта 1 уровня с нуля: вместимость / добыча в час', () => {
    assert.equal(fillTime(ready('goldmine')), T0 + Math.ceil((mine1.capacity * HOUR) / mine1.perHour));
  });

  it('частично собранная: считается от остатка', () => {
    const half = ready('goldmine', 1, T0, mine1.capacity / 2);
    assert.equal(fillTime(half), T0 + Math.ceil(((mine1.capacity / 2) * HOUR) / mine1.perHour));
  });

  it('уже полная — момент collectedAt', () => {
    assert.equal(fillTime(ready('goldmine', 1, T0, mine1.capacity)), T0);
  });

  it('во время улучшения: добыча стоит до конца стройки, дальше — по новому уровню', () => {
    const mine2 = PRODUCERS.goldmine.levels[1]!;
    const finishAt = T0 + 10 * MIN;
    const upgrading: BuildingState = { type: 'goldmine', level: 1, finishAt, collectedAt: T0, stored: 100 };
    const expected = finishAt + Math.ceil(((mine2.capacity - 100) * HOUR) / mine2.perHour);
    assert.equal(fillTime(upgrading), expected);
    assert.equal(accumulated(upgrading, expected), mine2.capacity);
  });

  it('новое здание в постройке заполняется после её окончания', () => {
    const building = { type: 'farm' as const, ...newBuildingState('farm', T0) };
    const lvl1 = PRODUCERS.farm.levels[0]!;
    assert.equal(fillTime(building), building.finishAt! + Math.ceil((lvl1.capacity * HOUR) / lvl1.perHour));
  });

  it('не добывающие здания — undefined', () => {
    assert.equal(fillTime(ready('barracks')), undefined);
    assert.equal(fillTime(ready('townhall')), undefined);
  });
});
