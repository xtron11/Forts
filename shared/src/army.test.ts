import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addToArmy,
  armyCapacity,
  barracksLevel,
  cancelTraining,
  checkTrain,
  scheduleTraining,
  settleTraining,
  usedHousing,
  type TrainingItem,
} from './army';
import type { BuildingState } from './economy';
import { CAMP_CAPACITY, TROOPS, troopLevelFor } from './troops';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const warrior1 = TROOPS.warrior.levels[0]!;

function barracks(level: number, finishAt: number | null = null): BuildingState {
  return { type: 'barracks', level, finishAt, collectedAt: T0, stored: 0 };
}

function camp(level: number, finishAt: number | null = null): BuildingState {
  return { type: 'camp', level, finishAt, collectedAt: T0, stored: 0 };
}

/** Казарма и лагерь 1-го уровня. */
const BASIC = [barracks(1), camp(1)];

function item(id: number, finishAt: number, troop: TrainingItem['troop'] = 'warrior'): TrainingItem {
  return { id, troop, level: 1, food: TROOPS[troop].levels[0]!.food, seconds: TROOPS[troop].levels[0]!.trainSeconds, finishAt };
}

const rich = { gold: 0, food: 100_000 };

describe('казарма и армия', () => {
  it('место в армии — сумма по лагерям, строящийся (ур. 0) и казармы не считаются', () => {
    assert.equal(armyCapacity([camp(1), camp(2), barracks(3)], T0), CAMP_CAPACITY[0]! + CAMP_CAPACITY[1]!);
    assert.equal(armyCapacity([camp(0, T0 + 1000)], T0), 0);
    assert.equal(armyCapacity([camp(0, T0 + 1000)], T0 + 1000), CAMP_CAPACITY[0]);
    assert.equal(barracksLevel([barracks(1), barracks(3)], T0), 3);
  });

  it('уровень войска зависит от лучшей казармы', () => {
    assert.equal(troopLevelFor('warrior', 1), 1);
    assert.equal(troopLevelFor('archer', 1), 0);
    assert.equal(troopLevelFor('ram', 3), 1);
    assert.equal(troopLevelFor('warrior', 4), TROOPS.warrior.levels.length);
  });

  it('нельзя без казармы, без лагеря, без нужного уровня, без места и без еды', () => {
    assert.deepEqual(checkTrain(rich, [camp(1)], [], [], 'warrior', 1, T0), { ok: false, reason: 'no_barracks' });
    assert.deepEqual(checkTrain(rich, [barracks(1)], [], [], 'warrior', 1, T0), { ok: false, reason: 'no_camp' });
    assert.deepEqual(checkTrain(rich, BASIC, [], [], 'ram', 1, T0), {
      ok: false,
      reason: 'barracks_level_too_low',
      requiredBarracks: TROOPS.ram.levels[0]!.barracksLevel,
    });
    assert.equal(checkTrain(rich, BASIC, [], [], 'dragon', 1, T0).ok, false);
    assert.equal(checkTrain(rich, BASIC, [], [], 'warrior', 0, T0).ok, false);

    const cap = CAMP_CAPACITY[0]!;
    const army = [{ troop: 'warrior' as const, level: 1, count: cap - 2 }];
    assert.equal(checkTrain(rich, BASIC, army, [], 'warrior', 2, T0).ok, true);
    assert.deepEqual(checkTrain(rich, BASIC, army, [item(1, T0 + 1)], 'warrior', 2, T0), { ok: false, reason: 'army_full', free: 1 });

    const poor = { gold: 0, food: warrior1.food * 3 - 1 };
    assert.deepEqual(checkTrain(poor, BASIC, [], [], 'warrior', 3, T0), { ok: false, reason: 'not_enough_resources' });
    assert.deepEqual(checkTrain(poor, BASIC, [], [], 'warrior', 2, T0), { ok: true, level: 1, food: warrior1.food, seconds: warrior1.trainSeconds });
  });

  it('юниты тренируются по одному друг за другом и переходят в армию после finishAt', () => {
    const s = warrior1.trainSeconds * 1000;
    const times = scheduleTraining([], warrior1.trainSeconds, 3, T0);
    assert.deepEqual(times, [T0 + s, T0 + 2 * s, T0 + 3 * s]);
    // Добавленные позже встают за последним.
    assert.deepEqual(scheduleTraining([{ finishAt: T0 + 3 * s }], warrior1.trainSeconds, 1, T0 + s), [T0 + 4 * s]);
    // Очередь закончилась в прошлом — отсчёт от now.
    assert.deepEqual(scheduleTraining([{ finishAt: T0 }], warrior1.trainSeconds, 1, T0 + s), [T0 + 2 * s]);

    const queue = times.map((t, i) => item(i + 1, t));
    const settled = settleTraining([], queue, T0 + 2 * s);
    assert.deepEqual(settled.army, [{ troop: 'warrior', level: 1, count: 2 }]);
    assert.deepEqual(settled.queue.map((q) => q.id), [3]);
    assert.deepEqual(settled.done.map((q) => q.id), [1, 2]);
    assert.equal(usedHousing(settled.army, settled.queue), 3);
  });

  it('отмена возвращает еду и сдвигает следующих раньше', () => {
    const s = warrior1.trainSeconds * 1000;
    const queue = [item(1, T0 + s), item(2, T0 + 2 * s), item(3, T0 + 3 * s)];
    // Первый тренируется, до конца 4 с — остальные сдвигаются на 4 с.
    const now = T0 + s - 4000;
    const first = cancelTraining(queue, 1, now)!;
    assert.equal(first.refund, warrior1.food);
    assert.deepEqual(first.queue.map((q) => q.finishAt), [T0 + 2 * s - 4000, T0 + 3 * s - 4000]);
    // Ещё не начатый — следующие сдвигаются на полное время.
    const middle = cancelTraining(queue, 2, T0)!;
    assert.deepEqual(middle.queue.map((q) => q.finishAt), [T0 + s, T0 + 2 * s]);
    assert.equal(cancelTraining(queue, 99, T0), undefined);
    assert.equal(cancelTraining(queue, 1, T0 + s), undefined, 'готовый юнит уже не отменить');
  });

  it('стеки армии упорядочены по типу и уровню', () => {
    let army = addToArmy([], 'ram', 1, 1);
    army = addToArmy(army, 'warrior', 2, 1);
    army = addToArmy(army, 'warrior', 1, 2);
    army = addToArmy(army, 'warrior', 1, 1);
    assert.deepEqual(army, [
      { troop: 'warrior', level: 1, count: 3 },
      { troop: 'warrior', level: 2, count: 1 },
      { troop: 'ram', level: 1, count: 1 },
    ]);
  });
});
