-- Поле 12×12 → 14×14 и новое здание «лагерь» (camp, 3×3).

-- 1. Базы сдвигаются на клетку вправо-вниз: ратуша снова в середине поля.
UPDATE buildings SET x = x + 1, y = y + 1;

-- 2. Место в армии теперь даёт лагерь, а не казарма. Чтобы никто не потерял
-- армию, за каждую казарму (уровень ≥ 1) игрок получает готовый лагерь того
-- же уровня — на ближайшем к казарме свободном месте 3×3. Нет места — лагерь
-- игрок построит сам. Размеры зданий — на момент этой миграции.
DO $$
DECLARE
  b record;
  cx integer;
  cy integer;
BEGIN
  FOR b IN
    SELECT id, player_id, x, y, LEAST(level, 4) AS level
    FROM buildings
    WHERE type = 'barracks' AND level >= 1
    ORDER BY player_id, id
  LOOP
    SELECT gx, gy INTO cx, cy
    FROM generate_series(0, 11) AS gx CROSS JOIN generate_series(0, 11) AS gy
    WHERE NOT EXISTS (
      SELECT 1
      FROM (
        SELECT o.x, o.y, CASE o.type WHEN 'townhall' THEN 3 WHEN 'camp' THEN 3 WHEN 'tower' THEN 1 WHEN 'wall' THEN 1 ELSE 2 END AS size
        FROM buildings o
        WHERE o.player_id = b.player_id
      ) AS o
      WHERE o.x < gx + 3 AND gx < o.x + o.size AND o.y < gy + 3 AND gy < o.y + o.size
    )
    -- Расстояние между центрами (в половинах клетки): лагерь 3×3, казарма 2×2.
    ORDER BY abs(2 * gx + 3 - 2 * b.x - 2) + abs(2 * gy + 3 - 2 * b.y - 2), gy, gx
    LIMIT 1;

    IF FOUND THEN
      INSERT INTO buildings (player_id, type, x, y, level) VALUES (b.player_id, 'camp', cx, cy, b.level);
    END IF;
  END LOOP;
END $$;
