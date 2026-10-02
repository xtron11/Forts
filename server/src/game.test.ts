/**
 * Интеграционные тесты игровых запросов: настоящий Postgres (forts_test),
 * запросы через app.inject, часы сервера подменяются.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  buildingPath,
  PRODUCERS,
  STARTING_RESOURCES,
  townhallConfig,
  type ApiErrorResponse,
  type BaseSnapshot,
  type CollectResponse,
  type PlaceBuildingResponse,
} from '@forts/shared';
import { buildApp } from './app';
import type { Db } from './db';
import { loginPlayer } from './players';
import { openTestDb, TEST_CONFIG } from './testing';

const db = await openTestDb();
const skip = db ? false : 'Postgres недоступен (npm run db:up) — тесты с базой пропущены';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const mine1 = PRODUCERS.goldmine.levels[0]!;
const mine2 = PRODUCERS.goldmine.levels[1]!;

let clock = T0;
let app: FastifyInstance;
let nextTelegramId = 1;

interface Player {
  id: number;
  token: string;
}

async function newPlayer(): Promise<Player> {
  const id = await loginPlayer(db as Db, { telegramId: nextTelegramId++, name: 'Test', languageCode: 'ru' });
  return { id, token: app.jwt.sign({ sub: String(id) }) };
}

async function call<T = BaseSnapshot>(player: Player, method: 'GET' | 'POST', url: string, body?: object) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${player.token}` }, payload: body });
  return { status: res.statusCode, body: res.json() as T & ApiErrorResponse };
}

const me = (p: Player) => call(p, 'GET', API_ROUTES.me).then((r) => r.body);
const place = (p: Player, type: string, x: number, y: number) => call<PlaceBuildingResponse>(p, 'POST', API_ROUTES.buildings, { type, x, y });
const upgrade = (p: Player, id: number) => call(p, 'POST', buildingPath(API_ROUTES.upgradeBuilding, id));
const collectFrom = (p: Player, id: number) => call<CollectResponse>(p, 'POST', buildingPath(API_ROUTES.collectBuilding, id));
const move = (p: Player, id: number, x: number, y: number) => call(p, 'POST', buildingPath(API_ROUTES.moveBuilding, id), { x, y });

async function setResources(p: Player, gold: number, food: number): Promise<void> {
  await db!.query('UPDATE players SET gold = $2, food = $3 WHERE id = $1', [p.id, gold, food]);
}

async function setTownhallLevel(p: Player, level: number): Promise<void> {
  await db!.query(`UPDATE buildings SET level = $2 WHERE player_id = $1 AND type = 'townhall'`, [p.id, level]);
}

/** Шахта, построенная и готовая к моменту clock. */
async function readyMine(p: Player, x = 0, y = 0): Promise<number> {
  const res = await place(p, 'goldmine', x, y);
  assert.equal(res.status, 201, res.body.message);
  clock += mine1.buildSeconds * SEC;
  return res.body.building.id;
}

describe('игровые запросы', { skip }, () => {
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
  });

  it('новый игрок: ратуша 1, стартовые ресурсы, время сервера', async () => {
    const p = await newPlayer();
    const base = await me(p);
    assert.equal(base.serverTime, T0);
    assert.deepEqual(base.player.resources, STARTING_RESOURCES);
    assert.equal(base.buildings.length, 1);
    assert.equal(base.buildings[0]!.type, 'townhall');
    assert.equal(base.buildings[0]!.level, 1);
    assert.equal(base.buildings[0]!.finishAt, null);
  });

  it('постройка списывает ресурсы и завершается ровно в finish_at', async () => {
    const p = await newPlayer();
    const res = await place(p, 'goldmine', 0, 0);
    assert.equal(res.status, 201);
    const finish = T0 + mine1.buildSeconds * SEC;
    assert.deepEqual(res.body.building, { ...res.body.building, level: 0, finishAt: finish });
    assert.deepEqual(res.body.player.resources, { gold: STARTING_RESOURCES.gold, food: STARTING_RESOURCES.food - mine1.cost.food });

    clock = finish - 1;
    let mine = (await me(p)).buildings.find((b) => b.id === res.body.building.id)!;
    assert.equal(mine.level, 0);
    assert.equal(mine.finishAt, finish);

    clock = finish;
    mine = (await me(p)).buildings.find((b) => b.id === res.body.building.id)!;
    assert.equal(mine.level, 1);
    assert.equal(mine.finishAt, null);
    assert.equal(mine.collectedAt, finish);
  });

  it('за 10 минут без игрока шахта накапливает ресурсы, сбор переносит их в хранилище', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    clock += 10 * MIN;
    const expected = Math.floor(mine1.perHour / 6);
    assert.ok(expected > 0);

    const res = await collectFrom(p, id);
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(res.body.collected, { resource: 'gold', amount: expected });
    assert.equal(res.body.player.resources.gold, STARTING_RESOURCES.gold + expected);

    const again = await collectFrom(p, id);
    assert.equal(again.status, 422);
    assert.equal(again.body.error, 'nothing_to_collect');
  });

  it('сбор не больше свободного места; при полном хранилище — storage_full', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    const cap = townhallConfig(1)!.storage.gold;
    await setResources(p, cap - 30, 1000);
    clock += 60 * MIN;

    const res = await collectFrom(p, id);
    assert.equal(res.body.collected.amount, 30);
    assert.equal(res.body.player.resources.gold, cap);
    const mine = res.body.buildings.find((b) => b.id === id)!;
    assert.equal(mine.stored, mine1.perHour - 30);

    const full = await collectFrom(p, id);
    assert.equal(full.status, 422);
    assert.equal(full.body.error, 'storage_full');
  });

  it('нельзя построить без ресурсов — ничего не списывается', async () => {
    const p = await newPlayer();
    await setResources(p, 1000, 10);
    const res = await place(p, 'goldmine', 0, 0);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'not_enough_resources');
    const base = await me(p);
    assert.deepEqual(base.player.resources, { gold: 1000, food: 10 });
    assert.equal(base.buildings.length, 1);
  });

  it('нельзя построить без свободного строителя', async () => {
    const p = await newPlayer();
    assert.equal((await place(p, 'goldmine', 0, 0)).status, 201);
    assert.equal((await place(p, 'farm', 0, 2)).status, 201);
    const res = await place(p, 'barracks', 0, 8);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_free_builder');

    clock += mine1.buildSeconds * SEC; // обе постройки закончились
    assert.equal((await place(p, 'barracks', 0, 8)).status, 201);
  });

  it('нельзя построить без нужного уровня ратуши и сверх лимита', async () => {
    const p = await newPlayer();
    const tower = await place(p, 'tower', 0, 0);
    assert.equal(tower.status, 422);
    assert.equal(tower.body.error, 'townhall_level_too_low');

    await setTownhallLevel(p, 2);
    assert.equal((await place(p, 'tower', 0, 0)).status, 201);
    const second = await place(p, 'tower', 1, 0);
    assert.equal(second.status, 422);
    assert.equal(second.body.error, 'limit_reached');
  });

  it('улучшение: списывает, занимает строителя, добыча стоит до finish_at', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    clock += 30 * MIN;
    const start = clock;
    const before = Math.floor(mine1.perHour / 2);

    const res = await upgrade(p, id);
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.player.resources.food, STARTING_RESOURCES.food - mine1.cost.food - mine2.cost.food);
    const mine = res.body.buildings.find((b) => b.id === id)!;
    assert.deepEqual([mine.level, mine.finishAt, mine.stored], [1, start + mine2.buildSeconds * SEC, before]);

    const busy = await upgrade(p, id);
    assert.equal(busy.body.error, 'under_construction');

    clock = start + mine2.buildSeconds * SEC + 60 * MIN;
    const done = await collectFrom(p, id);
    assert.equal(done.body.collected.amount, before + mine2.perHour);
    assert.equal(done.body.buildings.find((b) => b.id === id)!.level, 2);
  });

  it('двойной запрос улучшения списывает ресурсы один раз', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    const results = await Promise.all([upgrade(p, id), upgrade(p, id), upgrade(p, id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 422, 422]);
    const base = await me(p);
    assert.equal(base.player.resources.food, STARTING_RESOURCES.food - mine1.cost.food - mine2.cost.food);
  });

  it('двойной сбор не начисляет дважды', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    clock += 10 * MIN;
    const results = await Promise.all([collectFrom(p, id), collectFrom(p, id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 422]);
    assert.equal((await me(p)).player.resources.gold, STARTING_RESOURCES.gold + Math.floor(mine1.perHour / 6));
  });

  it('двойная постановка на одно место ставит одно здание', async () => {
    const p = await newPlayer();
    const results = await Promise.all([place(p, 'farm', 0, 0), place(p, 'farm', 0, 0)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 422]);
    const base = await me(p);
    assert.equal(base.buildings.length, 2);
    assert.equal(base.player.resources.gold, STARTING_RESOURCES.gold - PRODUCERS.farm.levels[0]!.cost.gold);
  });

  it('перемещение бесплатно и проверяет место', async () => {
    const p = await newPlayer();
    const id = await readyMine(p);
    const before = (await me(p)).player.resources;

    const ok = await move(p, id, 9, 9);
    assert.equal(ok.status, 200);
    const mine = ok.body.buildings.find((b) => b.id === id)!;
    assert.deepEqual([mine.x, mine.y], [9, 9]);
    assert.deepEqual(ok.body.player.resources, before);

    assert.equal((await move(p, id, 10, 9)).status, 200); // пересекается только с самим собой
    assert.equal((await move(p, id, 4, 4)).body.error, 'overlap');
    assert.equal((await move(p, id, 13, 13)).body.error, 'out_of_bounds'); // поле 14×14

    const other = await newPlayer();
    assert.equal((await move(other, id, 0, 0)).status, 404);
    assert.equal((await upgrade(other, id)).status, 404);
  });

  it('некорректный id — ошибка валидации', async () => {
    const p = await newPlayer();
    const res = await call(p, 'POST', '/buildings/abc/upgrade');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'validation');
  });
});
