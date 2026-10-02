/**
 * Закрытие боя: сервер сам прогоняет simulate() по базе, seed, армии на
 * начало и высадкам и применяет итог — списывает потраченные войска,
 * начисляет добычу (не больше свободного места в хранилище). То, что
 * показал клиент, не учитывается.
 *
 * Вызывается при итоге от игрока, при новом поиске (брошенный бой) и из
 * runAction, если итог не пришёл за BATTLE_FINISH_TIMEOUT_SECONDS.
 */
import {
  addToArmy,
  BATTLE_FINISH_TIMEOUT_SECONDS,
  checkOrders,
  freeStorage,
  simulate,
  type ArmyStack,
  type BattleBase,
  type BattleEndReason,
  type BattleReport,
  type DeployOrder,
  type PlacedBuilding,
  type Resources,
} from '@forts/shared';
import type pg from 'pg';
import { saveArmy, saveResources } from '../rows';

export interface BattleRow {
  id: number;
  player_id: number;
  status: 'scouting' | 'active' | 'finished';
  target_ref: string | null;
  target_townhall: number;
  base: BattleBase;
  seed: number;
  army: ArmyStack[] | null;
  deployments: DeployOrder[];
  end_tick: number | null;
  end_reason: BattleEndReason | null;
  /** troopsSurvived может не быть в итогах старых боёв. */
  result: (Omit<BattleReport, 'id' | 'troopsSurvived'> & Partial<Pick<BattleReport, 'troopsSurvived'>>) | null;
  started_at: Date | null;
}

export const BATTLE_COLUMNS =
  'id, player_id, status, target_ref, target_townhall, base, seed, army, deployments, end_tick, end_reason, result, started_at';

/** Состояние игрока, которое меняет итог боя; closeBattle обновляет его на месте. */
export interface PlayerState {
  playerId: number;
  now: number;
  resources: Resources;
  buildings: readonly PlacedBuilding[];
  army: ArmyStack[];
}

export function toReport(row: Pick<BattleRow, 'id' | 'result'>): BattleReport {
  // В итогах боёв до появления troopsSurvived этого поля нет.
  const result = row.result!;
  return { id: row.id, ...result, troopsSurvived: result.troopsSurvived ?? [] };
}

/**
 * Считает и применяет итог. orders уже проверены (или сохранены после
 * проверки); endTick — тик сдачи, undefined — бой до естественного конца.
 */
export async function closeBattle(
  client: pg.PoolClient,
  state: PlayerState,
  row: BattleRow,
  orders: readonly DeployOrder[],
  endTick: number | undefined,
  reason: BattleEndReason,
): Promise<BattleReport> {
  const army = row.army ?? [];
  const check = checkOrders(row.base, army, orders, endTick);
  // Сохранённые высадки уже проверялись; если что-то не так — бой без высадок.
  const deployments = check.ok ? check.deployments : [];
  const allUsed = check.ok ? check.allTroopsUsed : army.length === 0;
  const out = simulate(row.base, deployments, Number(row.seed), endTick, { endWhenNoTroops: allUsed });
  if (!out.ok) throw new Error(`battle ${row.id}: stored deployments rejected (${out.reason})`);
  const r = out.result;

  // Потраченные войска — из текущей армии (она не меньше армии на начало боя).
  let rest = state.army;
  for (const used of r.troopsUsed) rest = addToArmy(rest, used.troop, used.level, -used.count);
  rest = rest.filter((s) => s.count > 0);
  const free = freeStorage(state.resources, state.buildings, state.now);
  const gained: Resources = { gold: Math.min(r.loot.gold, free.gold), food: Math.min(r.loot.food, free.food) };
  const resources = { gold: state.resources.gold + gained.gold, food: state.resources.food + gained.food };

  await saveArmy(client, state.playerId, rest);
  await saveResources(client, state.playerId, resources);
  state.army = rest;
  state.resources = resources;

  const result: Omit<BattleReport, 'id'> = {
    reason,
    stars: r.stars,
    destruction: r.destruction,
    townhallDestroyed: r.townhallDestroyed,
    loot: r.loot,
    gained,
    troopsUsed: r.troopsUsed,
    troopsSurvived: r.troopsSurvived,
    endTick: r.endTick,
    hash: r.hash,
  };
  await client.query(
    `UPDATE battles SET status = 'finished', deployments = $2, end_tick = $3, end_reason = $4, result = $5, finished_at = $6
     WHERE id = $1`,
    [row.id, JSON.stringify(check.ok ? orders : []), r.endTick, reason, result, new Date(state.now)],
  );
  return { id: row.id, ...result };
}

/** Идущий бой игрока (заблокирован до конца транзакции). */
export async function activeBattle(client: pg.PoolClient, playerId: number): Promise<BattleRow | undefined> {
  const { rows } = await client.query<BattleRow>(
    `SELECT ${BATTLE_COLUMNS} FROM battles WHERE player_id = $1 AND status = 'active' FOR UPDATE`,
    [playerId],
  );
  return rows[0];
}

/** Бой, итог которого не пришёл вовремя, закрывается с теми высадками, что знает сервер. */
export async function expireBattle(client: pg.PoolClient, state: PlayerState): Promise<void> {
  const row = await activeBattle(client, state.playerId);
  if (!row || !row.started_at) return;
  if (state.now < row.started_at.getTime() + BATTLE_FINISH_TIMEOUT_SECONDS * 1000) return;
  await closeBattle(client, state, row, row.deployments, undefined, 'timeout');
}
