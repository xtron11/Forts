import type { BuildingType } from '../buildings';
import type { Resources } from '../resources';
import type { TroopType } from '../troops';

/**
 * Здание в снимке базы для боя. x/y — клетка основания с минимальными
 * координатами, как на базе игрока.
 */
export interface BattleBuilding {
  id: number;
  type: BuildingType;
  level: number;
  x: number;
  y: number;
  /** Сколько накоплено в шахте/ферме к началу боя; для остальных — 0 или нет. */
  stored?: number;
}

/**
 * Снимок базы-цели — единый формат для ботов и реальных игроков: всё, что
 * нужно бою, и ничего о времени. Реальную базу переводит battleBaseFromPlayer.
 */
export interface BattleBase {
  /** Сторона поля базы в клетках. */
  gridSize: number;
  /** Ресурсы в хранилище цели. */
  resources: Resources;
  buildings: BattleBuilding[];
}

/**
 * Высадка одного юнита. x/y — клетка в координатах базы; вне базы можно
 * высаживать до BATTLE_MARGIN клеток от края (координаты бывают < 0).
 */
export interface Deployment {
  troop: TroopType;
  level: number;
  x: number;
  y: number;
  /** Тик высадки, 0 ≤ tick < BATTLE_MAX_TICKS. */
  tick: number;
}

export type DeployError =
  | 'too_many_deployments'
  | 'unknown_troop'
  | 'invalid_level'
  | 'invalid_tick'
  | 'out_of_bounds'
  | 'forbidden_zone';

export type DeployCheck = { ok: true } | { ok: false; reason: DeployError; /** Номер неверной высадки. */ index: number };

/**
 * События боя для отрисовки. unit — номер высадки (индекс в deployments),
 * building — id здания. Положение юнита между событиями клиент получает,
 * повторяя бой пошагово (createBattle/stepBattle).
 */
export type BattleEvent =
  | { tick: number; kind: 'deploy'; unit: number; troop: TroopType; level: number; x: number; y: number }
  | { tick: number; kind: 'target'; unit: number; building: number }
  | { tick: number; kind: 'hit'; unit: number; building: number; damage: number }
  | { tick: number; kind: 'shot'; building: number; unit: number; damage: number }
  | { tick: number; kind: 'destroyed'; building: number; loot: Resources }
  | { tick: number; kind: 'unit_died'; unit: number }
  | { tick: number; kind: 'end' };

export interface TroopCount {
  troop: TroopType;
  level: number;
  count: number;
}

export interface BattleResult {
  /** false — бой остановлен на untilTick и ещё не закончен. */
  finished: boolean;
  /** Сколько тиков прошло. */
  endTick: number;
  /** Процент разрушения 0..100 (стены не считаются). */
  destruction: number;
  stars: number;
  townhallDestroyed: boolean;
  loot: Resources;
  /** Высаженные (потраченные) войска. */
  troopsUsed: TroopCount[];
  /** Выжившие к концу боя. */
  troopsSurvived: TroopCount[];
  /** Хэш итогового состояния — для проверки детерминизма и сверки с клиентом. */
  hash: number;
}
