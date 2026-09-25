import {
  checkPlacement,
  STARTING_BUILDINGS,
  STARTING_RESOURCES,
  type BuildingType,
  type MeResponse,
  type PlacedBuilding,
  type PlacementCheck,
  type PlayerDto,
} from '@forts/shared';
import { inTransaction, type Db } from './db';

interface PlayerRow {
  id: number;
  name: string;
  language_code: string;
  gold: number;
  food: number;
}

interface BuildingRow {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  level: number;
}

const PLAYER_COLUMNS = 'id, name, language_code, gold, food';
const BUILDING_COLUMNS = 'id, type, x, y, level';

function toPlayerDto(row: PlayerRow): PlayerDto {
  return { id: row.id, name: row.name, languageCode: row.language_code, resources: { gold: row.gold, food: row.food } };
}

function toBuilding(row: BuildingRow): PlacedBuilding {
  return { id: row.id, type: row.type, x: row.x, y: row.y, level: row.level };
}

export interface LoginProfile {
  telegramId: number;
  name: string;
  languageCode: string;
}

/**
 * Находит игрока по telegram_id, обновляя имя и язык, или создаёт нового
 * со стартовыми ресурсами и зданиями. Возвращает id игрока.
 */
export async function loginPlayer(db: Db, profile: LoginProfile): Promise<number> {
  return inTransaction(db, async (client) => {
    // При одновременном первом входе второй INSERT дождётся первого и ничего не вставит.
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO players (telegram_id, name, language_code, gold, food)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id) DO NOTHING
       RETURNING id`,
      [profile.telegramId, profile.name, profile.languageCode, STARTING_RESOURCES.gold, STARTING_RESOURCES.food],
    );
    const newId = inserted.rows[0]?.id;
    if (newId !== undefined) {
      for (const b of STARTING_BUILDINGS) {
        await client.query('INSERT INTO buildings (player_id, type, x, y) VALUES ($1, $2, $3, $4)', [newId, b.type, b.x, b.y]);
      }
      return newId;
    }

    const updated = await client.query<{ id: number }>(
      `UPDATE players SET name = $2, language_code = $3, last_seen_at = now()
       WHERE telegram_id = $1
       RETURNING id`,
      [profile.telegramId, profile.name, profile.languageCode],
    );
    return updated.rows[0]!.id;
  });
}

/** Игрок и его база; undefined, если игрока нет (например, удалён). */
export async function loadBase(db: Db, playerId: number): Promise<MeResponse | undefined> {
  const player = await db.query<PlayerRow>(
    `UPDATE players SET last_seen_at = now() WHERE id = $1 RETURNING ${PLAYER_COLUMNS}`,
    [playerId],
  );
  const row = player.rows[0];
  if (!row) return undefined;
  const buildings = await db.query<BuildingRow>(
    `SELECT ${BUILDING_COLUMNS} FROM buildings WHERE player_id = $1 ORDER BY id`,
    [playerId],
  );
  return { player: toPlayerDto(row), buildings: buildings.rows.map(toBuilding) };
}

export type PlaceResult = { ok: true; building: PlacedBuilding } | Extract<PlacementCheck, { ok: false }> | { ok: false; reason: 'not_found' };

/**
 * Ставит здание, если это разрешает checkPlacement из shared. Строка игрока
 * блокируется до конца транзакции, поэтому параллельные запросы одного
 * игрока проверяются по очереди и не могут поставить здания друг на друга.
 */
export async function placeBuilding(db: Db, playerId: number, type: string, x: number, y: number): Promise<PlaceResult> {
  return inTransaction(db, async (client) => {
    const player = await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (player.rowCount === 0) return { ok: false, reason: 'not_found' };

    const existing = await client.query<BuildingRow>(`SELECT ${BUILDING_COLUMNS} FROM buildings WHERE player_id = $1`, [playerId]);
    const check = checkPlacement(existing.rows, type, x, y);
    if (!check.ok) return check;

    const inserted = await client.query<BuildingRow>(
      `INSERT INTO buildings (player_id, type, x, y) VALUES ($1, $2, $3, $4) RETURNING ${BUILDING_COLUMNS}`,
      [playerId, type, x, y],
    );
    return { ok: true, building: toBuilding(inserted.rows[0]!) };
  });
}
