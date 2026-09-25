/**
 * Движок боя: детерминированная симуляция с фиксированным шагом
 * (TICKS_PER_SECOND тиков в секунду, не дольше BATTLE_MAX_TICKS).
 *
 * Детерминизм: только целые числа; здания обходятся по возрастанию id,
 * юниты — по номеру высадки; по объектам не итерируемся; случайность —
 * только Rng из seed. Один и тот же вход даёт один и тот же результат на
 * сервере и в клиенте, поэтому клиент может повторить бой для отрисовки,
 * а сервер — пересчитать и проверить.
 *
 * Порядок тика: высадка юнитов этого тика → ход юнитов → выстрелы башен.
 *
 * Бой можно вести и вживую (клиент): createBattle без высадок, затем
 * addDeployment на текущем тике и stepBattle. Если высадки идут по
 * неубывающим тикам, итог совпадает с simulate по тому же списку.
 */
import { addToArmy } from '../army';
import { levelConfig, producerLevel } from '../balance';
import { BUILDINGS, type BuildingType } from '../buildings';
import { RESOURCE_TYPES, type Resources, type ResourceType } from '../resources';
import { TILE, TROOPS, troopLevelConfig, type TroopConfig, type TroopLevel, type TroopType } from '../troops';
import {
  BATTLE_MARGIN,
  BATTLE_MAX_TICKS,
  MAX_DEPLOYMENTS,
  BUILDING_BLOCK_TILES,
  BUILDING_TARGET_GROUP,
  LOOT_PRODUCER_PERCENT,
  LOOT_STORAGE_PERCENT,
  STAR_DESTRUCTION_PERCENT,
  TOWER_LEVELS,
  type DefenseLevel,
} from './config';
import { distSqToRect, Hasher, idiv, isqrt, Rng, type Rect } from './math';
import { findPath, STEP_COST, tileAt, tileCenter, type PathGrid } from './path';
import { checkDeployments, normalizeBase } from './snapshot';
import type { BattleBase, BattleEvent, BattleResult, DeployCheck, DeployError, Deployment, TroopCount } from './types';

export interface BattleBuildingState {
  readonly id: number;
  readonly type: BuildingType;
  readonly level: number;
  readonly maxHp: number;
  hp: number;
  alive: boolean;
  /** Прямоугольник основания в единицах длины (координаты базы). */
  readonly rect: Rect;
  readonly centerX: number;
  readonly centerY: number;
  readonly isWall: boolean;
  readonly group: 'defense' | 'wall' | null;
  /** Что лежит в шахте/ферме и какой ресурс. */
  readonly resource: ResourceType | null;
  readonly stored: number;
  readonly defense: DefenseLevel | null;
  cooldown: number;
  /** Номер юнита-цели башни; −1 — нет. */
  target: number;
}

export interface BattleUnitState {
  /** Номер высадки. */
  readonly id: number;
  readonly troop: TroopType;
  readonly level: number;
  readonly config: TroopConfig;
  readonly stats: TroopLevel;
  readonly deployTick: number;
  spawned: boolean;
  alive: boolean;
  hp: number;
  /** Положение в единицах длины, координаты базы (клетка = TILE). */
  x: number;
  y: number;
  cooldown: number;
  /** Индекс здания-цели; −1 — нет. */
  target: number;
  /** Индекс здания на пути, которое юнит ломает; −1 — нет. */
  blocker: number;
  path: number[] | null;
  /** Индекс следующей клетки пути. */
  next: number;
  /** Юнит стоит ровно в центре клетки пути (может пересчитать путь). */
  atNode: boolean;
  pathVersion: number;
}

export interface BattleState {
  readonly base: BattleBase;
  tick: number;
  finished: boolean;
  readonly buildings: BattleBuildingState[];
  readonly units: BattleUnitState[];
  readonly grid: PathGrid;
  /** Меняется при каждом разрушении здания: пути нужно пересчитать. */
  version: number;
  readonly rng: Rng;
  /** Кэш путей текущей версии поля. */
  readonly pathCache: Map<string, number[]>;
  /** Номера юнитов в порядке высадки. */
  readonly spawnOrder: number[];
  spawned: number;
  /** Зданий, кроме стен, всего и разрушено. */
  readonly total: number;
  destroyed: number;
  townhallDestroyed: boolean;
  readonly lootable: Resources;
  loot: Resources;
  readonly log: BattleEvent[] | null;
  /**
   * Заканчивать бой, когда все высаженные юниты погибли и новых не
   * ожидается. false — у игрока ещё есть войска: бой идёт до конца времени,
   * 100% или сдачи (untilTick).
   */
  endWhenNoTroops: boolean;
}

export interface BattleOptions {
  /** Собирать события боя. */
  log?: boolean;
  /** См. BattleState.endWhenNoTroops; по умолчанию true. */
  endWhenNoTroops?: boolean;
}

export type CreateBattleResult = { ok: true; state: BattleState } | { ok: false; reason: DeployError; index: number };

/** Готовит бой. Неверная база — исключение, неверные высадки — отказ с кодом. */
export function createBattle(input: BattleBase, deployments: readonly Deployment[], seed: number, options: BattleOptions = {}): CreateBattleResult {
  const base = normalizeBase(input);
  const deploys: Deployment[] = deployments.map((d) => ({ troop: d.troop, level: d.level, x: d.x, y: d.y, tick: d.tick }));
  const check = checkDeployments(base, deploys);
  if (!check.ok) return check;
  if (!Number.isSafeInteger(seed)) throw new Error('battle: seed must be an integer');

  const size = base.gridSize + 2 * BATTLE_MARGIN;
  const grid: PathGrid = {
    size,
    margin: BATTLE_MARGIN,
    occupant: new Int32Array(size * size),
    wall: new Uint8Array(base.buildings.length),
    buildingCost: BUILDING_BLOCK_TILES * STEP_COST,
  };

  let total = 0;
  const buildings = base.buildings.map((b, i): BattleBuildingState => {
    const s = BUILDINGS[b.type].size;
    const isWall = b.type === 'wall';
    if (!isWall) total++;
    grid.wall[i] = isWall ? 1 : 0;
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) grid.occupant[(b.y + dy + BATTLE_MARGIN) * size + (b.x + dx + BATTLE_MARGIN)] = i + 1;
    }
    const hp = levelConfig(b.type, b.level)!.hp;
    const prod = producerLevel(b.type, b.level);
    return {
      id: b.id,
      type: b.type,
      level: b.level,
      maxHp: hp,
      hp,
      alive: true,
      rect: { minX: b.x * TILE, minY: b.y * TILE, maxX: (b.x + s) * TILE, maxY: (b.y + s) * TILE },
      centerX: b.x * TILE + (s * TILE) / 2,
      centerY: b.y * TILE + (s * TILE) / 2,
      isWall,
      group: BUILDING_TARGET_GROUP[b.type],
      resource: prod ? prod.resource : null,
      stored: prod ? (b.stored ?? 0) : 0,
      defense: b.type === 'tower' ? TOWER_LEVELS[Math.min(b.level, TOWER_LEVELS.length) - 1]! : null,
      cooldown: 0,
      target: -1,
    };
  });

  const units = deploys.map(makeUnit);
  // Сортировка устойчивая: при равном тике — по номеру высадки.
  const spawnOrder = units.map((u) => u.id).sort((a, b) => units[a]!.deployTick - units[b]!.deployTick || a - b);

  const lootable = { gold: idiv(base.resources.gold * LOOT_STORAGE_PERCENT, 100), food: idiv(base.resources.food * LOOT_STORAGE_PERCENT, 100) };

  return {
    ok: true,
    state: {
      base,
      tick: 0,
      finished: false,
      buildings,
      units,
      grid,
      version: 0,
      rng: new Rng(seed),
      pathCache: new Map(),
      spawnOrder,
      spawned: 0,
      total,
      destroyed: 0,
      townhallDestroyed: false,
      lootable,
      loot: { gold: 0, food: 0 },
      log: options.log ? [] : null,
      endWhenNoTroops: options.endWhenNoTroops ?? true,
    },
  };
}

function makeUnit(d: Deployment, id: number): BattleUnitState {
  return {
    id,
    troop: d.troop,
    level: d.level,
    config: TROOPS[d.troop],
    stats: troopLevelConfig(d.troop, d.level)!,
    deployTick: d.tick,
    spawned: false,
    alive: false,
    hp: 0,
    x: d.x * TILE + TILE / 2,
    y: d.y * TILE + TILE / 2,
    cooldown: 0,
    target: -1,
    blocker: -1,
    path: null,
    next: 0,
    atNode: true,
    pathVersion: 0,
  };
}

/**
 * Высадка во время живого боя — на текущий тик (юнит появится при
 * следующем stepBattle). Те же проверки, что у simulate.
 */
export function addDeployment(s: BattleState, input: Deployment): DeployCheck {
  const d: Deployment = { troop: input.troop, level: input.level, x: input.x, y: input.y, tick: input.tick };
  const index = s.units.length;
  if (index >= MAX_DEPLOYMENTS) return { ok: false, reason: 'too_many_deployments', index };
  if (s.finished || d.tick !== s.tick) return { ok: false, reason: 'invalid_tick', index };
  const check = checkDeployments(s.base, [d]);
  if (!check.ok) return { ...check, index };
  s.units.push(makeUnit(d, index));
  s.spawnOrder.push(index);
  return { ok: true };
}

function inRange(u: BattleUnitState, b: BattleBuildingState): boolean {
  return distSqToRect(u.x, u.y, b.rect) <= u.stats.range * u.stats.range;
}

/** Ближайшее живое здание первой непустой группы приоритета; при равенстве — меньший id. */
function chooseTarget(s: BattleState, u: BattleUnitState): number {
  for (const group of u.config.targets) {
    let best = -1;
    let bestDist = 0;
    for (let i = 0; i < s.buildings.length; i++) {
      const b = s.buildings[i]!;
      if (!b.alive) continue;
      if (group === 'any' ? b.isWall : b.group !== group) continue;
      const d = distSqToRect(u.x, u.y, b.rect);
      if (best < 0 || d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function destroyBuilding(s: BattleState, index: number): void {
  const b = s.buildings[index]!;
  b.alive = false;
  b.hp = 0;
  const occ = s.grid.occupant;
  for (let t = 0; t < occ.length; t++) if (occ[t] === index + 1) occ[t] = 0;
  s.version++;
  s.pathCache.clear();

  const gained: Resources = { gold: 0, food: 0 };
  if (!b.isWall) {
    s.destroyed++;
    // Доля хранилища: k-е разрушенное здание получает floor(L·k/N) − floor(L·(k−1)/N) — в сумме ровно L.
    for (const r of RESOURCE_TYPES) {
      const L = s.lootable[r];
      gained[r] += Math.floor((L * s.destroyed) / s.total) - Math.floor((L * (s.destroyed - 1)) / s.total);
    }
    if (b.resource) gained[b.resource] += idiv(b.stored * LOOT_PRODUCER_PERCENT, 100);
    if (b.type === 'townhall') s.townhallDestroyed = true;
  }
  s.loot = { gold: s.loot.gold + gained.gold, food: s.loot.food + gained.food };
  s.log?.push({ tick: s.tick, kind: 'destroyed', building: b.id, loot: gained });
}

function hitBuilding(s: BattleState, u: BattleUnitState, index: number): void {
  if (u.cooldown > 0) return;
  const b = s.buildings[index]!;
  const damage = b.isWall ? idiv(u.stats.damage * u.config.wallDamagePercent, 100) : u.stats.damage;
  u.cooldown = u.stats.attackTicks;
  b.hp -= damage;
  s.log?.push({ tick: s.tick, kind: 'hit', unit: u.id, building: b.id, damage });
  if (b.hp <= 0) destroyBuilding(s, index);
}

/** Если следующая клетка пути занята живым зданием (не целью) — его надо сломать. */
function checkAhead(s: BattleState, u: BattleUnitState): void {
  if (!u.path || u.next >= u.path.length) return;
  const occ = s.grid.occupant[u.path[u.next]!]!;
  if (occ !== 0 && occ - 1 !== u.target) u.blocker = occ - 1;
}

function planPath(s: BattleState, u: BattleUnitState): void {
  const start = tileAt(s.grid, u.x, u.y);
  const target = s.buildings[u.target]!;
  const wallCost = u.config.wallDetourTiles * STEP_COST;
  // Версия поля не входит в ключ: кэш очищается при каждом разрушении.
  const key = `${start}|${u.target}|${u.stats.range}|${wallCost}`;
  let path = s.pathCache.get(key);
  if (!path) {
    path = findPath(s.grid, { start, target: u.target, targetRect: target.rect, range: u.stats.range, wallCost });
    s.pathCache.set(key, path);
  }
  u.path = path;
  u.pathVersion = s.version;
  u.blocker = -1;
  const c = tileCenter(s.grid, start);
  if (c.x === u.x && c.y === u.y) {
    u.next = 1;
    u.atNode = true;
    checkAhead(s, u);
  } else {
    u.next = 0;
    u.atNode = false;
  }
}

function moveUnit(s: BattleState, u: BattleUnitState): void {
  const path = u.path!;
  let remaining = u.stats.speed;
  while (remaining > 0 && u.next < path.length && u.blocker < 0) {
    const c = tileCenter(s.grid, path[u.next]!);
    const dx = c.x - u.x;
    const dy = c.y - u.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d <= remaining) {
      u.x = c.x;
      u.y = c.y;
      remaining -= d;
      u.next++;
      u.atNode = true;
      // Поле изменилось — на следующем тике путь пересчитается отсюда.
      if (u.pathVersion !== s.version) return;
      checkAhead(s, u);
      if (inRange(u, s.buildings[u.target]!)) return;
    } else {
      u.x += idiv(dx * remaining, d);
      u.y += idiv(dy * remaining, d);
      u.atNode = false;
      remaining = 0;
    }
  }
}

function stepUnit(s: BattleState, u: BattleUnitState): void {
  if (!u.alive) return;
  if (u.cooldown > 0) u.cooldown--;

  if (u.target < 0 || !s.buildings[u.target]!.alive) {
    u.target = chooseTarget(s, u);
    u.path = null;
    u.blocker = -1;
    if (u.target < 0) return;
    s.log?.push({ tick: s.tick, kind: 'target', unit: u.id, building: s.buildings[u.target]!.id });
  }
  const target = s.buildings[u.target]!;
  if (inRange(u, target)) return hitBuilding(s, u, u.target);

  if (u.blocker >= 0) {
    const blocker = s.buildings[u.blocker]!;
    if (blocker.alive) {
      if (inRange(u, blocker)) return hitBuilding(s, u, u.blocker);
    }
    u.blocker = -1;
  }

  const stale = u.pathVersion !== s.version && u.atNode;
  if (!u.path || stale || u.next >= u.path.length) {
    planPath(s, u);
    if (u.blocker >= 0) {
      if (inRange(u, s.buildings[u.blocker]!)) return hitBuilding(s, u, u.blocker);
    }
  }
  if (u.blocker < 0) moveUnit(s, u);
}

function stepTower(s: BattleState, b: BattleBuildingState): void {
  const def = b.defense;
  if (!def || !b.alive) return;
  if (b.cooldown > 0) b.cooldown--;
  const rangeSq = def.range * def.range;
  const distSq = (u: BattleUnitState) => {
    const dx = u.x - b.centerX;
    const dy = u.y - b.centerY;
    return dx * dx + dy * dy;
  };
  if (b.target >= 0) {
    const u = s.units[b.target]!;
    if (!u.alive || distSq(u) > rangeSq) b.target = -1;
  }
  if (b.target < 0) {
    let best = -1;
    let bestDist = 0;
    for (const u of s.units) {
      if (!u.alive) continue;
      const d = distSq(u);
      if (d <= rangeSq && (best < 0 || d < bestDist)) {
        best = u.id;
        bestDist = d;
      }
    }
    b.target = best;
  }
  if (b.target < 0 || b.cooldown > 0) return;
  const u = s.units[b.target]!;
  b.cooldown = def.attackTicks;
  u.hp -= def.damage;
  s.log?.push({ tick: s.tick, kind: 'shot', building: b.id, unit: u.id, damage: def.damage });
  if (u.hp <= 0) {
    u.hp = 0;
    u.alive = false;
    b.target = -1;
    s.log?.push({ tick: s.tick, kind: 'unit_died', unit: u.id });
  }
}

/** Один тик боя. После конца боя ничего не делает. */
export function stepBattle(s: BattleState): void {
  if (s.finished) return;

  while (s.spawned < s.spawnOrder.length) {
    const u = s.units[s.spawnOrder[s.spawned]!]!;
    if (u.deployTick !== s.tick) break;
    u.spawned = true;
    u.alive = true;
    u.hp = u.stats.hp;
    // Разный сдвиг первого удара, чтобы толпа не била строго в такт.
    u.cooldown = s.rng.int(u.stats.attackTicks);
    s.spawned++;
    s.log?.push({
      tick: s.tick,
      kind: 'deploy',
      unit: u.id,
      troop: u.troop,
      level: u.level,
      x: Math.floor(u.x / TILE),
      y: Math.floor(u.y / TILE),
    });
  }

  for (const u of s.units) stepUnit(s, u);
  for (const b of s.buildings) stepTower(s, b);

  s.tick++;
  const allDestroyed = s.destroyed >= s.total;
  const noTroops = s.endWhenNoTroops && s.spawned >= s.spawnOrder.length && !s.units.some((u) => u.alive);
  if (allDestroyed || noTroops || s.tick >= BATTLE_MAX_TICKS) {
    s.finished = true;
    s.log?.push({ tick: s.tick, kind: 'end' });
  }
}

/** Хэш состояния: тик, HP зданий, положение и HP юнитов, добыча, состояние Rng. */
export function hashBattle(s: BattleState): number {
  const h = new Hasher().add(s.tick).add(s.finished ? 1 : 0).add(s.version);
  for (const b of s.buildings) h.add(b.id).add(b.hp).add(b.target + 1);
  for (const u of s.units) {
    h.add(u.alive ? 1 : 0)
      .add(u.hp)
      .add(u.x + 0x1_0000_0000)
      .add(u.y + 0x1_0000_0000)
      .add(u.target + 1);
  }
  return h.add(s.loot.gold).add(s.loot.food).add(s.rng.seedState).value;
}

function countTroops(units: readonly BattleUnitState[]): TroopCount[] {
  let stacks: TroopCount[] = [];
  for (const u of units) stacks = addToArmy(stacks, u.troop, u.level, 1);
  return stacks;
}

export function battleResult(s: BattleState): BattleResult {
  const destruction = s.total === 0 ? 100 : Math.floor((s.destroyed * 100) / s.total);
  const stars = (destruction >= STAR_DESTRUCTION_PERCENT ? 1 : 0) + (s.townhallDestroyed ? 1 : 0) + (destruction === 100 ? 1 : 0);
  return {
    finished: s.finished,
    endTick: s.tick,
    destruction,
    stars,
    townhallDestroyed: s.townhallDestroyed,
    loot: { ...s.loot },
    troopsUsed: countTroops(s.units.filter((u) => u.spawned)),
    troopsSurvived: countTroops(s.units.filter((u) => u.alive)),
    hash: hashBattle(s),
  };
}

export type SimulateOutcome =
  | { ok: true; result: BattleResult; log?: BattleEvent[] }
  | { ok: false; reason: DeployError; /** Номер неверной высадки. */ index: number };

/**
 * Бой целиком: чистая функция от базы, высадок и seed. untilTick —
 * остановиться на этом тике (для отрисовки/перемотки), бой тогда может быть
 * не закончен. options.log — вернуть события боя; options.endWhenNoTroops —
 * см. BattleState.
 */
export function simulate(
  base: BattleBase,
  deployments: readonly Deployment[],
  seed: number,
  untilTick?: number,
  options: BattleOptions = {},
): SimulateOutcome {
  const created = createBattle(base, deployments, seed, options);
  if (!created.ok) return created;
  const s = created.state;
  const limit = untilTick === undefined ? BATTLE_MAX_TICKS : Math.min(untilTick, BATTLE_MAX_TICKS);
  while (!s.finished && s.tick < limit) stepBattle(s);
  const result = battleResult(s);
  return s.log ? { ok: true, result, log: s.log } : { ok: true, result };
}
