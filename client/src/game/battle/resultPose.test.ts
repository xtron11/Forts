/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TroopType } from '@forts/shared';
import { pickResultPose } from './resultPose';

const used = [
  { troop: 'warrior' as const, level: 1, count: 5 },
  { troop: 'archer' as const, level: 1, count: 2 },
];
/** Анимации есть у всех войск. */
const all = () => true;

describe('pickResultPose', () => {
  it('победа — только выжившие', () => {
    const report = { stars: 2, troopsUsed: used, troopsSurvived: [{ troop: 'archer' as const, level: 1, count: 1 }] };
    for (const r of [0, 0.5, 0.99]) assert.deepEqual(pickResultPose(report, all, () => r), { troop: 'archer', anim: 'victory' });
  });

  it('несколько выживших войск — выбор случайный', () => {
    const report = { stars: 1, troopsUsed: used, troopsSurvived: used };
    assert.equal(pickResultPose(report, all, () => 0)!.troop, 'warrior');
    assert.equal(pickResultPose(report, all, () => 0.99)!.troop, 'archer');
  });

  it('поражение — только погибшие', () => {
    // Все лучники выжили, воины погибли не все.
    const report = {
      stars: 0,
      troopsUsed: used,
      troopsSurvived: [
        { troop: 'archer' as const, level: 1, count: 2 },
        { troop: 'warrior' as const, level: 1, count: 3 },
      ],
    };
    for (const r of [0, 0.99]) assert.deepEqual(pickResultPose(report, all, () => r), { troop: 'warrior', anim: 'defeat' });
  });

  it('нет анимации в атласе — персонаж не показывается', () => {
    const onlyWarriorVictory = (troop: TroopType, anim: string) => troop === 'warrior' && anim === 'victory';
    const survivedArchers = { stars: 3, troopsUsed: used, troopsSurvived: [used[1]!] };
    assert.equal(pickResultPose(survivedArchers, onlyWarriorVictory), null);
    const lost = { stars: 0, troopsUsed: used, troopsSurvived: [] };
    assert.equal(pickResultPose(lost, onlyWarriorVictory), null);
  });

  it('никто не выжил или никого не высаживали — никого', () => {
    assert.equal(pickResultPose({ stars: 1, troopsUsed: used, troopsSurvived: [] }, all), null);
    assert.equal(pickResultPose({ stars: 0, troopsUsed: [], troopsSurvived: [] }, all), null);
  });
});
