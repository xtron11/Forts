# Крепости

Стратегия для Telegram Mini App (Phaser + TypeScript). Описание проекта и принципы — в [claude.md](claude.md).

## Структура

- `client/` — игра: Vite + TypeScript + Phaser 4.
  - `src/platform/` — единственное место, где есть Telegram (TelegramPlatform) и тестовый игрок для браузера (BrowserPlatform).
  - `src/api/` — HTTP-клиент игрового API (JWT хранится только в памяти).
  - `src/game/` — сцены, изометрия, тема.
  - `src/i18n/` — тексты ru/en.
- `server/` — API на Fastify + PostgreSQL.
  - `migrations/` — SQL-миграции, применяются по порядку имён.
  - `src/telegram/initData.ts` — проверка подписи Telegram initData.
  - `src/players.ts` — игроки и здания в базе.
- `shared/` — общий код клиента и сервера: конфиги зданий, стартовая база, ресурсы, проверка размещения (`checkPlacement`), типы запросов и ответов API (`api.ts`).

## Первый запуск

Нужны Node.js 22+ и Docker.

```bash
npm install
cp server/.env.example server/.env   # и задать JWT_SECRET: openssl rand -hex 32
npm run db:up                        # Postgres в Docker на localhost:5433
npm run db:migrate                   # создать таблицы
npm run dev                          # сервер на :3000 и клиент на http://localhost:5173
```

Откройте http://localhost:5173 — войдёт тестовый игрок, база загрузится с сервера.

## Команды

```bash
npm run dev          # сервер и клиент вместе
npm run dev:server   # только сервер (перезапускается при изменениях)
npm run dev:client   # только клиент
npm run db:up        # поднять Postgres (docker compose)
npm run db:down      # остановить Postgres (данные сохраняются в volume)
npm run db:migrate   # применить новые миграции
npm test             # тесты shared и server
npm run typecheck    # проверка типов во всех пакетах
npm run build        # проверка типов + сборка клиента в client/dist
```

Сбросить базу полностью: `docker compose down -v`, затем `npm run db:up && npm run db:migrate`.

Если порт 5433 занят: `FORTS_DB_PORT=5434 npm run db:up` и тот же порт в `DATABASE_URL`.

## Настройки

`server/.env` (образец — `server/.env.example`), проверяется при старте, при ошибке сервер не запустится:

| Переменная | Назначение |
|---|---|
| `NODE_ENV` | `development`, `production` или `test` |
| `BOT_TOKEN` | токен бота от @BotFather — ключ для проверки initData |
| `DATABASE_URL` | строка подключения к Postgres |
| `JWT_SECRET` | секрет для JWT, не короче 32 символов |
| `CORS_ORIGIN` | адреса клиента через запятую |
| `HOST`, `PORT` | необязательно, по умолчанию `127.0.0.1:3000` |

`client/.env` (образец — `client/.env.example`): `VITE_API_URL` — адрес API. В режиме разработки по умолчанию `http://localhost:3000`, для сборки обязателен.

## API

Типы всех запросов и ответов — в `shared/src/api.ts`. Ошибки приходят как `{ "error": "<код>", "message": "..." }`.

| Запрос | Что делает |
|---|---|
| `POST /auth/telegram` `{ initData }` | проверяет подпись и возраст (≤ 24 ч), создаёт игрока при первом входе, возвращает JWT |
| `POST /auth/dev` `{ devId, name, languageCode }` | вход тестового игрока; существует **только** при `NODE_ENV=development` |
| `GET /me` | игрок, ресурсы, здания |
| `POST /buildings` `{ type, x, y }` | поставить здание; сервер проверяет тип, границы поля, пересечения и лимит (`400`/`422` при отказе) |

`/me` и `/buildings` требуют заголовок `Authorization: Bearer <token>`.

## Тестовый игрок в браузере

Вне Telegram клиент входит через `/auth/dev`, игрока можно настроить через URL:

- `?id=42` — номер тестового игрока, у каждого своя база (по умолчанию 1);
- `?lang=en` / `?lang=ru` — язык (по умолчанию язык браузера);
- `?name=Вася` — имя.

Тема берётся из системной настройки (светлая/тёмная).

## Запуск внутри Telegram

1. В `server/.env` указать настоящий `BOT_TOKEN` вашего бота.
2. Создать `client/.env` с `VITE_API_URL=/api` — запросы пойдут через dev-сервер Vite, и хватит одного туннеля.
3. `npm run dev` и туннель с HTTPS на клиент: `cloudflared tunnel --url http://localhost:5173` или `ngrok http 5173`.
4. В @BotFather: `/newapp` (или Menu Button у бота) — указать URL туннеля.
5. Открыть мини-приложение в Telegram. Платформа определяется автоматически по параметрам запуска (`#tgWebAppData`).

## Управление

- Перетаскивание пальцем/мышью по полю — двигать карту.
- Щипок двумя пальцами / колесо мыши — масштаб.
- Зажать здание на нижней панели и перетащить на поле — место подсвечивается зелёным (можно) или красным (нельзя); отпустить — поставить.
- Тап по пустой клетке — поставить выбранное на панели здание.
- Здание появляется только после подтверждения сервером; при отказе показывается короткое сообщение.
