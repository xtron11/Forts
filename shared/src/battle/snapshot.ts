/**
 * Снимок базы для боя и проверка входа: база приходит от сервера (ей
 * доверяем, ошибка — исключение), высадки — от игрока (ошибка — отказ с
 * кодом).
 */
import { levelConfig, producerLevel } from '../balance';
import { checkPlacement, type PlacedBuilding } from '../base';
import { BASE_GRID_SIZE, BUILDINGS, isBuildingType } from '../buildings';
import { accumulated, settleBuilding } from '../economy';
import { RESOURCE_TYPES, type Resources } from '../resources';
import { isTroopType, troopLevelConfig } from '../troops';
import {
  BATTLE_MARGIN,
  BATTLE_MAX_TICKS,
  DEPLOY_MIN_DISTANCE,
  LOOT_PRODUCER_PERCENT,
  LOOT_STORAGE_PERCENT,
  MAX_DEPLOYMENTS,
} from './config';
import { idiv } from './math';
import type { BattleBase, BattleBuilding, DeployCheck, Deployment } from './types';

/**
 * Снимок настоящей базы игрока в момент now: стройки, завершённые к now,
 * засчитаны; здание, которое ещё строится впервые (уровень 0), обороняется
 * как уровень 1; в шахтах и фермах — накопленное к now.
 */
export function battleBaseFromPlayer(buildings: readonly PlacedBuilding[], resources: Resources, now: number): BattleBase {
  return {
    gridSize: BASE_GRID_SIZE,
    resources: { gold: resources.gold, food: resources.food },
    buildings: buildings
      .map((b) => {
        const s = settleBuilding(b, now);
        return { id: s.id, type: s.type, level: Math.max(1, s.level), x: s.x, y: s.y, stored: accumulated(s, now) };
      })
      .sort((a, b) => a.id - b.id),
  };
}

function isNonNegativeInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

/**
 * Копия базы в каноническом виде (здания по id, только известные поля) и
 * проверка: целые числа, известные типы и уровни, здания в поле и не
 * пересекаются. Неверная база — ошибка сервера, поэтому исключение.
 */
export function normalizeBase(base: BattleBase): BattleBase {
  if (!Number.isSafeInteger(base.gridSize) || base.gridSize < 1 || base.gridSize > 64) throw new Error('battle: invalid gridSize');
  const resources = { gold: base.resources.gold, food: base.resources.food };
  for (const r of RESOURCE_TYPES) if (!isNonNegativeInt(resources[r])) throw new Error(`battle: invalid resource ${r}`);

  const buildings: BattleBuilding[] = base.buildings
    .map((b) => ({ id: b.id, type: b.type, level: b.level, x: b.x, y: b.y, stored: b.stored ?? 0 }))
    .sort((a, b) => a.id - b.id);
  const placed: BattleBuilding[] = [];
  for (const b of buildings) {
    if (!Number.isSafeInteger(b.id)) throw new Error('battle: invalid building id');
    if (placed.length > 0 && placed[placed.length - 1]!.id === b.id) throw new Error(`battle: duplicate building id ${b.id}`);
    if (!isBuildingType(b.type)) throw new Error(`battle: unknown building type ${String(b.type)}`);
    if (!Number.isSafeInteger(b.level) || !levelConfig(b.type, b.level)) throw new Error(`battle: invalid level of #${b.id}`);
    if (!isNonNegativeInt(b.stored)) throw new Error(`battle: invalid stored of #${b.id}`);
    const place = checkPlacement(placed, b.type, b.x, b.y, base.gridSize);
    if (!place.ok) throw new Error(`battle: building #${b.id} ${place.reason}`);
    placed.push(b);
  }
  return { gridSize: base.gridSize, resources, buildings };
}

/** Можно ли высадить юнит на клетку x/y: в поле боя и не ближе DEPLOY_MIN_DISTANCE к зданиям. */
export function canDeployAt(base: BattleBase, x: number, y: number): 'out_of_bounds' | 'forbidden_zone' | null {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return 'out_of_bounds';
  const lo = -BATTLE_MARGIN;
  const hi = base.gridSize + BATTLE_MARGIN;
  if (x < lo || y < lo || x >= hi || y >= hi) return 'out_of_bounds';
  const d = DEPLOY_MIN_DISTANCE;
  for (const b of base.buildings) {
    const size = BUILDINGS[b.type].size;
    if (x >= b.x - d && x < b.x + size + d && y >= b.y - d && y < b.y + size + d) return 'forbidden_zone';
  }
  return null;
}

/** Проверка высадок: число, войска, уровни, тики и зона высадки. */
export function checkDeployments(base: BattleBase, deployments: readonly Deployment[]): DeployCheck {
  if (deployments.length > MAX_DEPLOYMENTS) return { ok: false, reason: 'too_many_deployments', index: MAX_DEPLOYMENTS };
  for (let i = 0; i < deployments.length; i++) {
    const d = deployments[i]!;
    if (!isTroopType(d.troop)) return { ok: false, reason: 'unknown_troop', index: i };
    if (!Number.isSafeInteger(d.level) || !troopLevelConfig(d.troop, d.level)) return { ok: false, reason: 'invalid_level', index: i };
    if (!Number.isSafeInteger(d.tick) || d.tick < 0 || d.tick >= BATTLE_MAX_TICKS) return { ok: false, reason: 'invalid_tick', index: i };
    const zone = canDeployAt(base, d.x, d.y);
    if (zone) return { ok: false, reason: zone, index: i };
  }
  return { ok: true };
}

/** Сколько можно унести при 100% разрушения — «возможная добыча» на экране поиска. */
export function maxLoot(base: BattleBase): Resources {
  const loot: Resources = {
    gold: idiv(base.resources.gold * LOOT_STORAGE_PERCENT, 100),
    food: idiv(base.resources.food * LOOT_STORAGE_PERCENT, 100),
  };
  for (const b of base.buildings) {
    const prod = producerLevel(b.type, b.level);
    if (prod) loot[prod.resource] += idiv((b.stored ?? 0) * LOOT_PRODUCER_PERCENT, 100);
  }
  return loot;
}
