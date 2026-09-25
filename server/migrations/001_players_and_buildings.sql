CREATE TABLE players (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Для тестовых игроков режима разработки — отрицательные числа.
  telegram_id   bigint NOT NULL UNIQUE,
  name          text NOT NULL,
  language_code text NOT NULL DEFAULT 'en',
  gold          integer NOT NULL CHECK (gold >= 0),
  food          integer NOT NULL CHECK (food >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buildings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  type       text NOT NULL,
  x          integer NOT NULL,
  y          integer NOT NULL,
  level      integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX buildings_player_id_idx ON buildings (player_id);
