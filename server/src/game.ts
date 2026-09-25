/**
 * Игровые действия с базой игрока. Решения принимают чистые функции из
 * shared (economy.ts), здесь — только чтение и запись в транзакции.
 *
 * Каждое действие блокирует строку игрока (SELECT ... FOR UPDATE), поэтому
 * запросы одного игрока выполняются строго по очереди: второй из двух
 * быстрых одинаковых запросов видит результат первого (здание уже
 * улучшается, ресурсы уже собраны) и не списывает/не начисляет повторно.
 */
import {
  accumulated,
  armyCapacity,
  cancelTraining,
  checkBuild,
  checkPlacement,
  checkTrain,
  checkUpgrade,
  collect,
  newBuildingState,
  scheduleTraining,
  settleBuilding,
  settleTraining,
  startUpgrade,
  subtractCost,
  usedHousing,
  type ApiErrorCode,
  type ArmyDto,
  type ArmyStack,
  type BaseSnapshot,
  type BuildingType,
  type PlacedBuilding,
  type PlayerDto,
  type Resources,
  type ResourceType,
  type RuleCheck,
  type TrainCheck,
  type TrainingItem,
} from '@forts/shared';
import type pg from 'pg';
import { inTransaction, type Db } from './db';
import { trackEvent } from './events';
import { planNotifications } from './notifications/plan';
import { shouldAskWriteAccess } from './notifications/policy';
import { botCanMessage, syncNotifications } from './notifications/store';
import { BUILDING_COLUMNS, loadArmy, loadBuildings, loadTraining, toBuilding, type BuildingRow } from './rows';

interface PlayerRow {
  id: number;
  telegram_id: number;
  name: string;
  language_code: string;
  gold: number;
  food: number;
  can_message: boolean;
  notifications_off: string[];
  write_access_asked_at: Date | null;
}

const PLAYER_COLUMNS = 'id, telegram_id, name, language_code, gold, food, can_message, notifications_off, write_access_asked_at';

export interface Failure {
  error: ApiErrorCode;
  message: string;
}

function fail(error: ApiErrorCode, message: string): Failure {
  return { error, message };
}

export function isFailure(value: object): value is Failure {
  return 'error' in value;
}

function ruleFailure(check: Extract<RuleCheck, { ok: false }>, what: string): Failure {
  const details = [check.missing && `missing ${check.missing}`, check.requiredTownhall && `town hall ${check.requiredTownhall} required`]
    .filter(Boolean)
    .join(', ');
  return fail(check.reason, `Cannot ${what}: ${check.reason}${details ? ` (${details})` : ''}`);
}

function trainFailure(check: Extract<TrainCheck, { ok: false }>, troop: string): Failure {
  const details = [check.requiredBarracks && `barracks ${check.requiredBarracks} required`, check.free !== undefined && `${check.free} free`]
    .filter(Boolean)
    .join(', ');
  return fail(check.reason, `Cannot train ${troop}: ${check.reason}${details ? ` (${details})` : ''}`);
}

/**
 * База игрока внутри транзакции: ресурсы, здания с завершёнными к now
 * стройками, армия с дотренированными к now юнитами и оставшаяся очередь.
 */
interface BaseTx {
  client: pg.PoolClient;
  playerId: number;
  now: number;
  resources: Resources;
  buildings: PlacedBuilding[];
  army: ArmyStack[];
  queue: TrainingItem[];
}

async function saveBuilding(client: pg.PoolClient, b: PlacedBuilding): Promise<void> {
  await client.query(
    `UPDATE buildings SET x = $2, y = $3, level = $4, finish_at = $5, collected_at = $6, stored = $7 WHERE id = $1`,
    [b.id, b.x, b.y, b.level, b.finishAt === null ? null : new Date(b.finishAt), new Date(b.collectedAt), b.stored],
  );
}

async function saveResources(client: pg.PoolClient, playerId: number, r: Resources): Promise<void> {
  await client.query('UPDATE players SET gold = $2, food = $3 WHERE id = $1', [playerId, r.gold, r.food]);
}

/**
 * Переводит дотренированные к now юниты из очереди в армию — как стройки,
 * при первом запросе после finish_at.
 */
async function settleArmy(client: pg.PoolClient, playerId: number, now: number): Promise<{ army: ArmyStack[]; queue: TrainingItem[] }> {
  const settled = settleTraining(await loadArmy(client, playerId), await loadTraining(client, playerId), now);
  if (settled.done.length > 0) {
    await client.query('DELETE FROM training_queue WHERE id = ANY($1)', [settled.done.map((q) => q.id)]);
    for (const s of settled.army) {
      await client.query(
        `INSERT INTO army (player_id, troop, level, count) VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id, troop, level) DO UPDATE SET count = EXCLUDED.count`,
        [playerId, s.troop, s.level, s.count],
      );
    }
  }
  return { army: settled.army, queue: settled.queue };
}

function toArmyDto(buildings: readonly PlacedBuilding[], army: ArmyStack[], queue: TrainingItem[], now: number): ArmyDto {
  return { capacity: armyCapacity(buildings, now), used: usedHousing(army, queue), troops: army, queue };
}

function toPlayerDto(p: PlayerRow, buildings: readonly PlacedBuilding[], now: number): PlayerDto {
  return {
    id: p.id,
    name: p.name,
    languageCode: p.language_code,
    resources: { gold: p.gold, food: p.food },
    askWriteAccess: shouldAskWriteAccess(
      { canMessage: p.can_message, writeAccessAskedAt: p.write_access_asked_at?.getTime() ?? null },
      buildings,
      now,
    ),
  };
}

/**
 * Выполняет действие над базой игрока в транзакции и возвращает его
 * результат вместе со свежим состоянием базы. Перед действием завершает
 * все стройки, у которых наступил finish_at, — так здания «достраиваются»
 * без cron, при первом же запросе.
 *
 * Любой запрос — это «игрок в игре»: last_seen_at = now, и будущие
 * уведомления пересчитываются по новому состоянию базы.
 */
async function runAction<T extends object>(
  db: Db,
  playerId: number,
  now: number,
  action: (tx: BaseTx) => Promise<T | Failure>,
): Promise<(T & BaseSnapshot) | Failure> {
  return inTransaction(db, async (client) => {
    const player = await client.query<PlayerRow>(
      `UPDATE players SET last_seen_at = $2 WHERE id = $1 RETURNING ${PLAYER_COLUMNS}`,
      [playerId, new Date(now)],
    );
    const row = player.rows[0];
    if (!row) return fail('unauthorized', 'Player not found');
    // UPDATE уже заблокировал строку игрока до конца транзакции — это и есть очередь запросов.

    const buildings: PlacedBuilding[] = [];
    for (const b of await loadBuildings(client, playerId)) {
      const settled = settleBuilding(b, now);
      if (settled !== b) await saveBuilding(client, settled);
      buildings.push(settled);
    }

    const { army, queue } = await settleArmy(client, playerId, now);

    const tx: BaseTx = { client, playerId, now, resources: { gold: row.gold, food: row.food }, buildings, army, queue };
    const result = await action(tx);

    const fresh = await client.query<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`, [playerId]);
    const p = fresh.rows[0]!;
    const all = await loadBuildings(client, playerId);
    const freshArmy = await loadArmy(client, playerId);
    const freshQueue = await loadTraining(client, playerId);
    // Игрок видит базу сейчас: уведомлять можно только о том, что случится позже.
    const planned = planNotifications({
      buildings: all,
      training: freshQueue,
      since: now,
      canMessage: botCanMessage(p),
      disabled: p.notifications_off,
    });
    await syncNotifications(client, playerId, planned, now);

    if (isFailure(result)) return result;
    return {
      ...result,
      serverTime: now,
      player: toPlayerDto(p, all, now),
      buildings: all,
      army: toArmyDto(all, freshArmy, freshQueue, now),
    };
  });
}

function findBuilding(tx: BaseTx, id: number): PlacedBuilding | Failure {
  return tx.buildings.find((b) => b.id === id) ?? fail('not_found', `Building ${id} not found`);
}

export function loadBase(db: Db, playerId: number, now: number) {
  return runAction(db, playerId, now, async () => ({}));
}

/** Ставит новое здание: место свободно, позволяет ратуша, есть строитель и ресурсы. */
export function placeBuilding(db: Db, playerId: number, type: string, x: number, y: number, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    const place = checkPlacement(tx.buildings, type, x, y);
    if (!place.ok) return fail(place.reason, `Cannot place ${type} at (${x}, ${y}): ${place.reason}`);
    const rules = checkBuild(tx.resources, tx.buildings, type, tx.now);
    if (!rules.ok) return ruleFailure(rules, `build ${type}`);

    await saveResources(tx.client, tx.playerId, subtractCost(tx.resources, rules.level.cost));
    const state = newBuildingState(type as BuildingType, tx.now);
    const inserted = await tx.client.query<BuildingRow>(
      `INSERT INTO buildings (player_id, type, x, y, level, finish_at, collected_at, stored)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${BUILDING_COLUMNS}`,
      [
        tx.playerId,
        type,
        x,
        y,
        state.level,
        state.finishAt === null ? null : new Date(state.finishAt),
        new Date(state.collectedAt),
        state.stored,
      ],
    );
    return { building: toBuilding(inserted.rows[0]!) };
  });
}

/** Начинает улучшение здания до следующего уровня. */
export function upgradeBuilding(db: Db, playerId: number, id: number, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    const building = findBuilding(tx, id);
    if (isFailure(building)) return building;
    const rules = checkUpgrade(tx.resources, tx.buildings, building, tx.now);
    if (!rules.ok) return ruleFailure(rules, `upgrade ${building.type} #${id}`);

    await saveResources(tx.client, tx.playerId, subtractCost(tx.resources, rules.level.cost));
    await saveBuilding(tx.client, startUpgrade(building, tx.now));
    return {};
  });
}

/** Забирает накопленное из шахты/фермы, не больше свободного места в хранилище. */
export function collectBuilding(db: Db, playerId: number, id: number, now: number) {
  return runAction<{ collected: { resource: ResourceType; amount: number } }>(db, playerId, now, async (tx) => {
    const building = findBuilding(tx, id);
    if (isFailure(building)) return building;
    const result = collect(building, tx.resources, tx.buildings, tx.now);
    if (!result) return fail('not_producer', `${building.type} #${id} does not produce resources`);
    if (result.amount === 0) {
      return accumulated(building, tx.now) > 0
        ? fail('storage_full', `Storage for ${result.resource} is full`)
        : fail('nothing_to_collect', `Nothing to collect in #${id}`);
    }

    const resources = { ...tx.resources, [result.resource]: tx.resources[result.resource] + result.amount };
    await saveResources(tx.client, tx.playerId, resources);
    await saveBuilding(tx.client, result.building);
    return { collected: { resource: result.resource, amount: result.amount } };
  });
}

/**
 * Ответ игрока на предложение уведомлений. Разрешил — бот может писать
 * (и сразу планируются уведомления); отказ запоминается, чтобы не
 * спрашивать чаще раза в неделю.
 */
export function setWriteAccess(db: Db, playerId: number, granted: boolean, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    await tx.client.query(
      granted
        ? 'UPDATE players SET can_message = true, allows_write_to_pm = true, bot_blocked_at = NULL, write_access_asked_at = $2 WHERE id = $1'
        : 'UPDATE players SET write_access_asked_at = $2 WHERE id = $1',
      [tx.playerId, new Date(tx.now)],
    );
    await trackEvent(tx.client, tx.playerId, 'write_access', { granted }, tx.now);
    return {};
  });
}

/** Переносит здание на новое место; бесплатно, в том числе во время стройки. */
export function moveBuilding(db: Db, playerId: number, id: number, x: number, y: number, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    const building = findBuilding(tx, id);
    if (isFailure(building)) return building;
    const others = tx.buildings.filter((b) => b.id !== id);
    const place = checkPlacement(others, building.type, x, y);
    if (!place.ok) return fail(place.reason, `Cannot move #${id} to (${x}, ${y}): ${place.reason}`);

    await saveBuilding(tx.client, { ...building, x, y });
    return {};
  });
}

/**
 * Заказывает count юнитов troop: есть казарма нужного уровня, место в
 * армии (с учётом очереди) и еда. Юниты встают в конец очереди по одному.
 */
export function trainTroops(db: Db, playerId: number, troop: string, count: number, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    const check = checkTrain(tx.resources, tx.buildings, tx.army, tx.queue, troop, count, tx.now);
    if (!check.ok) return trainFailure(check, troop);

    await saveResources(tx.client, tx.playerId, { ...tx.resources, food: tx.resources.food - check.food * count });
    for (const finishAt of scheduleTraining(tx.queue, check.seconds, count, tx.now)) {
      await tx.client.query(
        `INSERT INTO training_queue (player_id, troop, level, food, seconds, finish_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tx.playerId, troop, check.level, check.food, check.seconds, new Date(finishAt), new Date(tx.now)],
      );
    }
    return {};
  });
}

/** Убирает юнит из очереди и возвращает его еду; следующие юниты будут готовы раньше. */
export function cancelTrainingItem(db: Db, playerId: number, id: number, now: number) {
  return runAction(db, playerId, now, async (tx) => {
    const result = cancelTraining(tx.queue, id, tx.now);
    if (!result) return fail('not_found', `Training item ${id} not found`);

    await tx.client.query('DELETE FROM training_queue WHERE id = $1', [id]);
    const before = new Map(tx.queue.map((q) => [q.id, q.finishAt]));
    for (const q of result.queue) {
      if (before.get(q.id) === q.finishAt) continue;
      await tx.client.query('UPDATE training_queue SET finish_at = $2 WHERE id = $1', [q.id, new Date(q.finishAt)]);
    }
    await saveResources(tx.client, tx.playerId, { ...tx.resources, food: tx.resources.food + result.refund });
    return {};
  });
}
