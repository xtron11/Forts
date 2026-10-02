/**
 * Казарма и армия через API: очередь тренировки, отмена, место в армии,
 * уведомление army_ready. Настоящий Postgres (forts_test).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  CAMP_CAPACITY,
  BUILDING_LEVELS,
  buildingPath,
  STARTING_RESOURCES,
  TROOPS,
  type ApiErrorResponse,
  type BaseSnapshot,
  type PlaceBuildingResponse,
} from '@forts/shared';
import { buildApp } from './app';
import type { NotificationSender } from './notifications/sender';
import { NOTIFY_TIMING } from './notifications/timing';
import { processDueNotifications } from './notifications/worker';
import { loginPlayer } from './players';
import { openTestDb, TEST_CONFIG } from './testing';

const db = await openTestDb();
const skip = db ? false : 'Postgres недоступен (npm run db:up) — тесты с базой пропущены';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const warrior1 = TROOPS.warrior.levels[0]!;
const barracks1 = BUILDING_LEVELS.barracks[0]!;
const camp1 = BUILDING_LEVELS.camp[0]!;

let clock = T0;
let app: FastifyInstance;
let nextTelegramId = 5000;

const sent: string[] = [];
const sender: NotificationSender = {
  async send(_chatId, text) {
    sent.push(text);
    return { ok: true };
  },
};

interface Player {
  id: number;
  token: string;
}

async function newPlayer(allows = false): Promise<Player> {
  const id = await loginPlayer(db!, { telegramId: nextTelegramId++, name: 'Test', languageCode: 'ru', allowsWriteToPm: allows }, clock);
  return { id, token: app.jwt.sign({ sub: String(id) }) };
}

async function call<T = BaseSnapshot>(p: Player, method: 'GET' | 'POST', url: string, body?: object) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, payload: body });
  return { status: res.statusCode, body: res.json() as T & ApiErrorResponse };
}

const me = (p: Player) => call(p, 'GET', API_ROUTES.me).then((r) => r.body);
const train = (p: Player, troop: string, count: number) => call(p, 'POST', API_ROUTES.trainTroops, { troop, count });
const cancel = (p: Player, id: number) => call(p, 'POST', buildingPath(API_ROUTES.cancelTraining, id));

async function setFood(p: Player, food: number): Promise<void> {
  await db!.query('UPDATE players SET food = $2 WHERE id = $1', [p.id, food]);
}

/** Казарма и лагерь, построенные к моменту clock (оба строителя заняты одновременно). */
async function readyBarracks(p: Player): Promise<void> {
  for (const [type, x] of [['barracks', 0], ['camp', 3]] as const) {
    const res = await call<PlaceBuildingResponse>(p, 'POST', API_ROUTES.buildings, { type, x, y: 0 });
    assert.equal(res.status, 201, res.body.message);
  }
  clock += Math.max(barracks1.buildSeconds, camp1.buildSeconds) * SEC;
}

describe('казарма и армия', { skip }, () => {
  before(async () => {
    await db!.query('TRUNCATE players RESTART IDENTITY CASCADE');
    app = await buildApp({ config: TEST_CONFIG, db: db!, now: () => clock });
  });

  after(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(() => {
    clock = T0;
    sent.length = 0;
  });

  it('без казармы тренировать нельзя; неизвестное войско — 400', async () => {
    const p = await newPlayer();
    const res = await train(p, 'warrior', 1);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_barracks');
    assert.equal((await train(p, 'dragon', 1)).body.error, 'unknown_troop');
    assert.equal((await train(p, 'warrior', 0)).status, 400);
    const base = await me(p);
    assert.deepEqual(base.army, { capacity: 0, used: 0, troops: [], queue: [] });
  });

  it('очередь: еда списывается, юниты готовы по одному в свой finish_at', async () => {
    const p = await newPlayer();
    await readyBarracks(p);
    const start = clock;
    const res = await train(p, 'warrior', 3);
    assert.equal(res.status, 200, res.body.message);
    const food = STARTING_RESOURCES.food - barracks1.cost.food - camp1.cost.food - 3 * warrior1.food;
    assert.equal(res.body.player.resources.food, food);
    const step = warrior1.trainSeconds * SEC;
    assert.deepEqual(
      res.body.army.queue.map((q) => q.finishAt),
      [start + step, start + 2 * step, start + 3 * step],
    );
    assert.equal(res.body.army.capacity, CAMP_CAPACITY[0]);
    assert.equal(res.body.army.used, 3);

    clock = start + step - 1;
    assert.deepEqual((await me(p)).army.troops, []);
    clock = start + step;
    let base = await me(p);
    assert.deepEqual(base.army.troops, [{ troop: 'warrior', level: 1, count: 1 }]);
    assert.equal(base.army.queue.length, 2);

    clock = start + 10 * step;
    base = await me(p);
    assert.deepEqual(base.army.troops, [{ troop: 'warrior', level: 1, count: 3 }]);
    assert.deepEqual(base.army.queue, []);
    assert.equal(base.army.used, 3);
    // Готовые юниты не пропадают при повторных запросах.
    assert.deepEqual((await me(p)).army.troops, [{ troop: 'warrior', level: 1, count: 3 }]);
  });

  it('нельзя без еды и без места', async () => {
    const p = await newPlayer();
    await readyBarracks(p);
    await setFood(p, warrior1.food - 1);
    const poor = await train(p, 'warrior', 1);
    assert.equal(poor.status, 422);
    assert.equal(poor.body.error, 'not_enough_resources');

    await setFood(p, 100_000);
    const cap = CAMP_CAPACITY[0]!;
    assert.equal((await train(p, 'warrior', cap)).status, 200);
    const full = await train(p, 'warrior', 1);
    assert.equal(full.status, 422);
    assert.equal(full.body.error, 'army_full');
    // Место занимают и готовые юниты.
    clock += cap * warrior1.trainSeconds * SEC;
    assert.equal((await train(p, 'warrior', 1)).body.error, 'army_full');
  });

  it('без лагеря тренировать некуда', async () => {
    const p = await newPlayer();
    const res = await call<PlaceBuildingResponse>(p, 'POST', API_ROUTES.buildings, { type: 'barracks', x: 0, y: 0 });
    assert.equal(res.status, 201, res.body.message);
    clock += barracks1.buildSeconds * SEC;
    assert.equal((await train(p, 'warrior', 1)).body.error, 'no_camp');
  });

  it('таран требует казарму 3-го уровня', async () => {
    const p = await newPlayer();
    await readyBarracks(p);
    await setFood(p, 100_000);
    assert.equal((await train(p, 'ram', 1)).body.error, 'barracks_level_too_low');
    await db!.query(`UPDATE buildings SET level = 3 WHERE player_id = $1 AND type = 'barracks'`, [p.id]);
    const res = await train(p, 'ram', 2);
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.army.used, 2 * TROOPS.ram.housing);
    // Место даёт лагерь, а не казарма.
    assert.equal(res.body.army.capacity, CAMP_CAPACITY[0]);
  });

  it('отмена возвращает еду и сдвигает очередь', async () => {
    const p = await newPlayer();
    await readyBarracks(p);
    const start = clock;
    const res = await train(p, 'warrior', 3);
    const [first, second, third] = res.body.army.queue;
    const foodAfterTrain = res.body.player.resources.food;
    const step = warrior1.trainSeconds * SEC;

    clock = start + 4 * SEC;
    const cancelled = await cancel(p, first!.id);
    assert.equal(cancelled.status, 200, cancelled.body.message);
    assert.equal(cancelled.body.player.resources.food, foodAfterTrain + warrior1.food);
    // Первому оставалось step − 4 с — на столько раньше готовы остальные.
    assert.deepEqual(
      cancelled.body.army.queue.map((q) => [q.id, q.finishAt]),
      [
        [second!.id, second!.finishAt - (step - 4 * SEC)],
        [third!.id, third!.finishAt - (step - 4 * SEC)],
      ],
    );

    const again = await cancel(p, first!.id);
    assert.equal(again.status, 404);
    // Чужой юнит не отменить.
    const other = await newPlayer();
    assert.equal((await cancel(other, second!.id)).status, 404);
  });

  it('army_ready: одно уведомление, когда готов последний юнит', async () => {
    const p = await newPlayer(true);
    await readyBarracks(p);
    const start = clock;
    await train(p, 'warrior', 2);
    await train(p, 'warrior', 1);
    const doneAt = start + 3 * warrior1.trainSeconds * SEC;

    const { rows } = await db!.query<{ key: string; event_at: Date; status: string }>(
      `SELECT key, event_at, status FROM notifications WHERE player_id = $1 AND type = 'army_ready'`,
      [p.id],
    );
    assert.deepEqual(rows, [{ key: 'army', event_at: new Date(doneAt), status: 'pending' }]);

    // Игрок ушёл из игры; уведомление уходит после готовности армии и окна «в игре».
    clock = doneAt + NOTIFY_TIMING.activeWindowMs + MIN;
    const tick = await processDueNotifications({ db: db!, sender, timing: NOTIFY_TIMING, now: () => clock });
    assert.equal(tick.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /[Аа]рми|[Вв]ойск/);
  });
});
