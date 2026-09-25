-- Этап 5а: казарма и армия.

-- Готовые юниты игрока: по строке на (тип, уровень).
CREATE TABLE army (
  player_id bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  troop     text NOT NULL,
  level     integer NOT NULL CHECK (level >= 1),
  count     integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (player_id, troop, level)
);

-- Очередь тренировки: строка на юнит. Юниты тренируются по одному,
-- finish_at каждого — за предыдущим. Готовые переходят в army при первом
-- запросе после finish_at (как стройки, без cron).
CREATE TABLE training_queue (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  troop      text NOT NULL,
  level      integer NOT NULL CHECK (level >= 1),
  -- Сколько еды списано — столько вернётся при отмене.
  food       integer NOT NULL CHECK (food >= 0),
  seconds    integer NOT NULL CHECK (seconds >= 0),
  finish_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX training_queue_player_idx ON training_queue (player_id, finish_at);
