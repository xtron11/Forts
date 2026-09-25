-- Этап 5б: бои с базами-ботами.
--
-- Строка боя проходит путь scouting (цель найдена, игрок смотрит превью)
-- → active (бой идёт, started_at) → finished (итог посчитан сервером).
-- Хранится всё для повтора: снимок базы, seed, армия на начало, высадки.
CREATE TABLE battles (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id         bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('scouting', 'active', 'finished')),
  -- Кого атакуем: бот (шаблон target_ref); позже — игрок.
  target_kind       text NOT NULL DEFAULT 'bot',
  target_ref        text,
  target_townhall   integer NOT NULL,
  base              jsonb NOT NULL,
  seed              bigint NOT NULL,
  -- Армия на начало боя: из неё высаживаются войска и назначаются уровни.
  army              jsonb,
  -- Высадки игрока как он их прислал (тик, войско, клетка); уровни — по army.
  deployments       jsonb NOT NULL DEFAULT '[]',
  end_tick          integer,
  end_reason        text CHECK (end_reason IN ('finish', 'timeout', 'abandoned')),
  -- Итог (BattleReport без id).
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

-- Одновременно у игрока не больше одной найденной цели или идущего боя.
CREATE UNIQUE INDEX battles_one_open_idx ON battles (player_id) WHERE status IN ('scouting', 'active');
CREATE INDEX battles_player_idx ON battles (player_id, created_at);
