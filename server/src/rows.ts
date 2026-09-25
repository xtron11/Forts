/** Строки таблиц и их перевод в типы shared — общие для игры, уведомлений и бота. */
import { addToArmy, type ArmyStack, type BuildingType, type PlacedBuilding, type TrainingItem, type TroopType } from '@forts/shared';
import type pg from 'pg';

export interface BuildingRow {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  level: number;
  finish_at: Date | null;
  collected_at: Date;
  stored: number;
}

export const BUILDING_COLUMNS = 'id, type, x, y, level, finish_at, collected_at, stored';

export function toBuilding(row: BuildingRow): PlacedBuilding {
  return {
    id: row.id,
    type: row.type,
    x: row.x,
    y: row.y,
    level: row.level,
    finishAt: row.finish_at?.getTime() ?? null,
    collectedAt: row.collected_at.getTime(),
    stored: row.stored,
  };
}

/** Здания игрока как они лежат в базе (стройки, у которых прошёл finish_at, не завершены). */
export async function loadBuildings(client: pg.PoolClient, playerId: number): Promise<PlacedBuilding[]> {
  const { rows } = await client.query<BuildingRow>(`SELECT ${BUILDING_COLUMNS} FROM buildings WHERE player_id = $1 ORDER BY id`, [playerId]);
  return rows.map(toBuilding);
}

interface ArmyRow {
  troop: TroopType;
  level: number;
  count: number;
}

/** Готовые юниты игрока как они лежат в базе (без учёта завершившейся тренировки). */
export async function loadArmy(client: pg.PoolClient, playerId: number): Promise<ArmyStack[]> {
  const { rows } = await client.query<ArmyRow>('SELECT troop, level, count FROM army WHERE player_id = $1', [playerId]);
  // Порядок стеков — как в shared (по типу и уровню).
  return rows.reduce<ArmyStack[]>((army, r) => addToArmy(army, r.troop, r.level, r.count), []);
}

interface TrainingRow {
  id: number;
  troop: TroopType;
  level: number;
  food: number;
  seconds: number;
  finish_at: Date;
}

/** Очередь тренировки по порядку готовности (включая уже готовые, но ещё не переведённые в армию). */
export async function loadTraining(client: pg.PoolClient, playerId: number): Promise<TrainingItem[]> {
  const { rows } = await client.query<TrainingRow>(
    'SELECT id, troop, level, food, seconds, finish_at FROM training_queue WHERE player_id = $1 ORDER BY finish_at, id',
    [playerId],
  );
  return rows.map((r) => ({ id: r.id, troop: r.troop, level: r.level, food: r.food, seconds: r.seconds, finishAt: r.finish_at.getTime() }));
}
