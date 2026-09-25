/** Строки таблиц и их перевод в типы shared — общие для игры, уведомлений и бота. */
import type { BuildingType, PlacedBuilding } from '@forts/shared';
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
