-- Этап 3: стройка и добыча без фоновых таймеров.
-- level 0 — новое здание ещё строится; пока finish_at не NULL, идёт стройка
-- до level + 1. Сервер завершает её при любом запросе после finish_at.
ALTER TABLE buildings DROP CONSTRAINT buildings_level_check;
ALTER TABLE buildings ADD CONSTRAINT buildings_level_check CHECK (level >= 0);

ALTER TABLE buildings ADD COLUMN finish_at timestamptz;
-- С какого момента идёт добыча (шахта, ферма).
ALTER TABLE buildings ADD COLUMN collected_at timestamptz NOT NULL DEFAULT now();
-- Сколько уже лежало в здании к collected_at; во время улучшения добыча стоит на этом значении.
ALTER TABLE buildings ADD COLUMN stored integer NOT NULL DEFAULT 0 CHECK (stored >= 0);
