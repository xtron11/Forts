-- Этап 4: бот, уведомления и статистика.

-- Откуда пришёл игрок: параметр /start или startapp при первом появлении.
ALTER TABLE players ADD COLUMN source text;
-- Часовой пояс устройства (IANA) — для тихих часов; NULL — считаем UTC.
ALTER TABLE players ADD COLUMN timezone text;
-- Последнее значение allows_write_to_pm из initData.
ALTER TABLE players ADD COLUMN allows_write_to_pm boolean NOT NULL DEFAULT false;
-- Может ли бот писать игроку: /start, разрешение в мини-приложении или allows_write_to_pm.
ALTER TABLE players ADD COLUMN can_message boolean NOT NULL DEFAULT false;
-- Telegram ответил 403 (бот заблокирован): не пишем до следующего /start.
ALTER TABLE players ADD COLUMN bot_blocked_at timestamptz;
-- Когда в игре последний раз спрашивали разрешение писать (и игрок не разрешил).
ALTER TABLE players ADD COLUMN write_access_asked_at timestamptz;
-- Выключенные типы уведомлений (/settings).
ALTER TABLE players ADD COLUMN notifications_off text[] NOT NULL DEFAULT '{}';
-- Счётчик отправленных сообщений — по нему чередуются варианты фраз.
ALTER TABLE players ADD COLUMN notify_counter integer NOT NULL DEFAULT 0;

-- Будущие уведомления. Одна строка на (игрок, тип, объект): при каждом
-- изменении базы сервер пересчитывает event_at и переиспользует строку.
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  type       text NOT NULL,
  -- Объект события: id здания для build_done, ресурс для storage_full.
  key        text NOT NULL,
  -- Когда событие происходит в игре.
  event_at   timestamptz NOT NULL,
  -- Когда отправлять: event_at или позже (игрок в игре, тихие часы, лимиты).
  send_at    timestamptz NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  attempts   integer NOT NULL DEFAULT 0,
  sent_at    timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, type, key)
);

CREATE INDEX notifications_due_idx ON notifications (send_at) WHERE status = 'pending';

-- События для статистики удержания: вход, отправка уведомления, вход по уведомлению.
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  type       text NOT NULL,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_player_type_idx ON events (player_id, type, created_at);
CREATE INDEX events_type_created_idx ON events (type, created_at);
