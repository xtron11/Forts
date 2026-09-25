/**
 * Высадки от игрока: тик, войско и клетка — без уровня. Уровень юнита
 * берётся из армии игрока на начало боя (сначала старшие уровни), поэтому
 * клиент и сервер получают один и тот же список Deployment.
 */
import type { ArmyStack } from '../army';
import { isTroopType, type TroopType } from '../troops';
import { BATTLE_MAX_TICKS, MAX_DEPLOYMENTS } from './config';
import { canDeployAt } from './snapshot';
import type { BattleBase, DeployError, Deployment } from './types';

export interface DeployOrder {
  /** Тик высадки; тики не убывают. */
  tick: number;
  troop: TroopType;
  x: number;
  y: number;
}

export type OrderError = DeployError | 'ticks_not_sorted' | 'not_enough_troops';

export type OrdersCheck =
  | {
      ok: true;
      deployments: Deployment[];
      /** Высажена вся армия — бой кончается, когда все юниты погибли (endWhenNoTroops). */
      allTroopsUsed: boolean;
    }
  | { ok: false; reason: OrderError; /** Номер неверной высадки. */ index: number };

/** Сколько юнитов в армии. */
export function armyUnits(army: readonly ArmyStack[]): number {
  return army.reduce((sum, s) => sum + s.count, 0);
}

/** Сколько юнитов каждого войска осталось в армии после высадок. */
export function remainingTroops(army: readonly ArmyStack[], orders: readonly Pick<DeployOrder, 'troop'>[]): Map<TroopType, number> {
  const left = new Map<TroopType, number>();
  for (const s of army) left.set(s.troop, (left.get(s.troop) ?? 0) + s.count);
  for (const o of orders) left.set(o.troop, (left.get(o.troop) ?? 0) - 1);
  return left;
}

/**
 * Проверяет высадки игрока и назначает уровни: тики целые, не убывают и
 * меньше endTick (если бой уже закончен на этом тике), войска есть в
 * армии на начало боя, клетки в разрешённой зоне.
 */
export function checkOrders(base: BattleBase, army: readonly ArmyStack[], orders: readonly DeployOrder[], endTick?: number): OrdersCheck {
  if (orders.length > MAX_DEPLOYMENTS) return { ok: false, reason: 'too_many_deployments', index: MAX_DEPLOYMENTS };
  const limit = endTick ?? BATTLE_MAX_TICKS;
  // Оставшиеся юниты по войскам и уровням; уровни — от старших к младшим.
  const stock = army
    .filter((s) => s.count > 0)
    .map((s) => ({ ...s }))
    .sort((a, b) => b.level - a.level);
  const deployments: Deployment[] = [];
  let prevTick = 0;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    if (!isTroopType(o.troop)) return { ok: false, reason: 'unknown_troop', index: i };
    if (!Number.isSafeInteger(o.tick) || o.tick < 0 || o.tick >= limit || o.tick >= BATTLE_MAX_TICKS) {
      return { ok: false, reason: 'invalid_tick', index: i };
    }
    if (o.tick < prevTick) return { ok: false, reason: 'ticks_not_sorted', index: i };
    prevTick = o.tick;
    const zone = canDeployAt(base, o.x, o.y);
    if (zone) return { ok: false, reason: zone, index: i };
    const stack = stock.find((s) => s.troop === o.troop && s.count > 0);
    if (!stack) return { ok: false, reason: 'not_enough_troops', index: i };
    stack.count--;
    deployments.push({ troop: o.troop, level: stack.level, x: o.x, y: o.y, tick: o.tick });
  }
  return { ok: true, deployments, allTroopsUsed: deployments.length === armyUnits(army) };
}
