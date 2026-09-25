/**
 * Протокол боя с базой-ботом:
 *   search  — найти цель (превью и возможная добыча); «Следующая» стоит золота;
 *   start   — бой начался: время начала на сервере, база и seed для клиента;
 *   deployments — клиент по ходу боя присылает высадки (их сервер применит,
 *             если итог не придёт);
 *   finish  — высадки и тик конца; сервер проверяет их и считает итог сам.
 * Одновременно у игрока одна найденная цель или один идущий бой.
 */
import { randomInt } from 'node:crypto';
import {
  armyUnits,
  BATTLE_MAX_TICKS,
  botTemplatesFor,
  checkOrders,
  generateBotBase,
  maxLoot,
  searchCost,
  TICKS_PER_SECOND,
  townhallLevel,
  type ActiveBattleDto,
  type BattleReport,
  type BattleTargetDto,
  type DeployOrder,
} from '@forts/shared';
import type { Db } from '../db';
import { fail, runAction, type BaseTx, type Failure } from '../game';
import { saveResources } from '../rows';
import { activeBattle, BATTLE_COLUMNS, closeBattle, toReport, type BattleRow, type PlayerState } from './close';

/** Запас на задержку сети при проверке «не быстрее тиков», мс. */
const CLOCK_TOLERANCE_MS = 2000;
const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

function playerState(tx: BaseTx): PlayerState {
  return { playerId: tx.playerId, now: tx.now, resources: tx.resources, buildings: tx.buildings, army: tx.army };
}

/** Переносит в tx то, что поменял closeBattle. */
function applyState(tx: BaseTx, state: PlayerState): void {
  tx.resources = state.resources;
  tx.army = state.army;
}

function toTarget(row: BattleRow, attackerTownhall: number): BattleTargetDto {
  return {
    id: row.id,
    townhallLevel: row.target_townhall,
    base: row.base,
    lootPreview: maxLoot(row.base),
    nextCost: searchCost(attackerTownhall),
  };
}

function randomSeed(): number {
  return randomInt(0, 2 ** 31);
}

async function scoutingBattle(tx: BaseTx): Promise<BattleRow | undefined> {
  const { rows } = await tx.client.query<BattleRow>(
    `SELECT ${BATTLE_COLUMNS} FROM battles WHERE player_id = $1 AND status = 'scouting' FOR UPDATE`,
    [tx.playerId],
  );
  return rows[0];
}

/**
 * Цель для атаки. Брошенный идущий бой сначала закрывается с известными
 * высадками. Без next возвращается уже найденная цель (или первая —
 * бесплатно), с next — новая за золото.
 */
export function searchBattle(db: Db, playerId: number, next: boolean, now: number) {
  return runAction<{ target: BattleTargetDto }>(db, playerId, now, async (tx) => {
    const active = await activeBattle(tx.client, tx.playerId);
    if (active) {
      const state = playerState(tx);
      await closeBattle(tx.client, state, active, active.deployments, undefined, 'abandoned');
      applyState(tx, state);
    }

    const th = townhallLevel(tx.buildings, tx.now);
    const current = await scoutingBattle(tx);
    if (current && !next) return { target: toTarget(current, th) };
    if (current) {
      const cost = searchCost(th);
      if (tx.resources.gold < cost) return fail('not_enough_resources', `Next target costs ${cost} gold`);
      tx.resources = { ...tx.resources, gold: tx.resources.gold - cost };
      await saveResources(tx.client, tx.playerId, tx.resources);
      await tx.client.query('DELETE FROM battles WHERE id = $1', [current.id]);
    }

    // Та же база два раза подряд — скучно: предыдущий шаблон пропускаем, если есть другие.
    const all = botTemplatesFor(th);
    const fresh = all.filter((t) => t.id !== current?.target_ref);
    const pool = fresh.length > 0 ? fresh : all;
    const template = pool[randomInt(0, pool.length)]!;
    const base = generateBotBase(template, randomSeed());
    const { rows } = await tx.client.query<BattleRow>(
      `INSERT INTO battles (player_id, status, target_kind, target_ref, target_townhall, base, seed, created_at)
       VALUES ($1, 'scouting', 'bot', $2, $3, $4, $5, $6) RETURNING ${BATTLE_COLUMNS}`,
      [tx.playerId, template.id, template.townhallLevel, base, randomSeed(), new Date(tx.now)],
    );
    return { target: toTarget(rows[0]!, th) };
  });
}

/** Начинает бой с найденной целью: запоминает время начала и армию. */
export function startBattle(db: Db, playerId: number, now: number) {
  return runAction<{ battle: ActiveBattleDto }>(db, playerId, now, async (tx) => {
    const row = await scoutingBattle(tx);
    if (!row) return fail('no_target', 'Search for a target first');
    if (armyUnits(tx.army) === 0) return fail('no_troops', 'Train some troops first');
    await tx.client.query(`UPDATE battles SET status = 'active', started_at = $2, army = $3 WHERE id = $1`, [
      row.id,
      new Date(tx.now),
      JSON.stringify(tx.army),
    ]);
    return { battle: { id: row.id, base: row.base, seed: Number(row.seed), army: tx.army, startedAt: tx.now } };
  });
}

async function findBattle(tx: BaseTx, id: number): Promise<BattleRow | Failure> {
  const { rows } = await tx.client.query<BattleRow>(`SELECT ${BATTLE_COLUMNS} FROM battles WHERE id = $1 AND player_id = $2 FOR UPDATE`, [
    id,
    tx.playerId,
  ]);
  const row = rows[0];
  if (!row || row.status === 'scouting') return fail('battle_not_found', `Battle ${id} not found`);
  return row;
}

function isFailure(value: object): value is Failure {
  return 'error' in value;
}

function sameOrder(a: DeployOrder, b: DeployOrder): boolean {
  return a.tick === b.tick && a.troop === b.troop && a.x === b.x && a.y === b.y;
}

/**
 * Общие проверки высадок идущего боя: уже сохранённые нельзя поменять,
 * войска есть в армии на начало, тики и зона верные, и реальное время с
 * начала боя не меньше, чем прошло тиков.
 */
function checkProgress(tx: BaseTx, row: BattleRow, orders: readonly DeployOrder[], endTick?: number): Failure | undefined {
  const saved = row.deployments;
  if (orders.length < saved.length || saved.some((o, i) => !sameOrder(o, orders[i]!))) {
    return fail('deployments_changed', 'Deployments already sent cannot be changed');
  }
  const check = checkOrders(row.base, row.army ?? [], orders, endTick);
  if (!check.ok) return fail(check.reason, `Deployment #${check.index} rejected: ${check.reason}`);
  const lastTick = endTick ?? (orders.length > 0 ? orders[orders.length - 1]!.tick : 0);
  const elapsed = tx.now - row.started_at!.getTime();
  if (lastTick * MS_PER_TICK > elapsed + CLOCK_TOLERANCE_MS) {
    return fail('battle_too_fast', `Tick ${lastTick} is ahead of real time (${elapsed} ms since start)`);
  }
  return undefined;
}

/** Промежуточные высадки: если итог не придёт, бой закроется с ними. */
export function saveDeployments(db: Db, playerId: number, id: number, orders: DeployOrder[], now: number) {
  return runAction<{ saved: number }>(db, playerId, now, async (tx) => {
    const row = await findBattle(tx, id);
    if (isFailure(row)) return row;
    if (row.status === 'finished') return fail('battle_finished', `Battle ${id} is already finished`);
    const problem = checkProgress(tx, row, orders);
    if (problem) return problem;
    await tx.client.query('UPDATE battles SET deployments = $2 WHERE id = $1', [id, JSON.stringify(orders)]);
    return { saved: orders.length };
  });
}

/**
 * Итог боя. Повторный запрос (например, после обрыва связи) возвращает
 * уже посчитанный итог и ничего не начисляет.
 */
export function finishBattle(db: Db, playerId: number, id: number, orders: DeployOrder[], endTick: number, now: number) {
  return runAction<{ report: BattleReport }>(db, playerId, now, async (tx) => {
    const row = await findBattle(tx, id);
    if (isFailure(row)) return row;
    if (row.status === 'finished') return { report: toReport(row) };
    if (!Number.isSafeInteger(endTick) || endTick < 0 || endTick > BATTLE_MAX_TICKS) {
      return fail('invalid_tick', `Invalid end tick ${endTick}`);
    }
    const problem = checkProgress(tx, row, orders, endTick);
    if (problem) return problem;
    const state = playerState(tx);
    const report = await closeBattle(tx.client, state, row, orders, endTick, 'finish');
    applyState(tx, state);
    return { report };
  });
}
