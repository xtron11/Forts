import { STARTING_BUILDINGS, STARTING_RESOURCES } from '@forts/shared';
import { inTransaction, type Db } from './db';

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
