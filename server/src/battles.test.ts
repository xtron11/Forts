/**
 * Бой с базой-ботом через API: поиск, начало, проверка высадок, итог,
 * таймаут. Итог сервера сверяется с тем, что насчитал бы клиент тем же
 * движком. Настоящий Postgres (forts_test).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  addDeployment,
  API_ROUTES,
  BATTLE_FINISH_TIMEOUT_SECONDS,
  BATTLE_MARGIN,
  BATTLE_MAX_TICKS,
  battleResult,
  buildingPath,
  canDeployAt,
  checkOrders,
  createBattle,
  searchCost,
  stepBattle,
  STARTING_RESOURCES,
  TICKS_PER_SECOND,
  townhallConfig,
  type ActiveBattleDto,
  type ApiErrorResponse,
  type ArmyStack,
  type BaseSnapshot,
  type BattleBase,
  type BattleFinishResponse,
  type BattleResult,
  type BattleSearchResponse,
  type BattleStartResponse,
  type DeployOrder,
  type TroopType,
} from '@forts/shared';
import { buildApp } from './app';
import { saveArmy } from './rows';
import { loginPlayer } from './players';
import { openTestDb, TEST_CONFIG } from './testing';

const db = await openTestDb();
const skip = db ? false : 'Postgres недоступен (npm run db:up) — тесты с базой пропущены';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

let clock = T0;
let app: FastifyInstance;
let nextTelegramId = 9000;

interface Player {
  id: number;
  token: string;
}

const ARMY: ArmyStack[] = [
  { troop: 'warrior', level: 1, count: 10 },
  { troop: 'archer', level: 1, count: 6 },
  { troop: 'ram', level: 1, count: 1 },
];

async function newPlayer(army: ArmyStack[] = ARMY): Promise<Player> {
  const id = await loginPlayer(db!, { telegramId: nextTelegramId++, name: 'Test', languageCode: 'ru' }, clock);
  if (army.length > 0) {
    const client = await db!.connect();
    try {
      await saveArmy(client, id, army);
    } finally {
      client.release();
    }
  }
  return { id, token: app.jwt.sign({ sub: String(id) }) };
}

async function call<T = BaseSnapshot>(p: Player, url: string, body?: object, method: 'GET' | 'POST' = 'POST') {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, payload: body ?? (method === 'POST' ? {} : undefined) });
  return { status: res.statusCode, body: res.json() as T & ApiErrorResponse };
}

const me = (p: Player) => call(p, API_ROUTES.me, undefined, 'GET').then((r) => r.body);
const search = (p: Player, next = false) => call<BattleSearchResponse>(p, API_ROUTES.battleSearch, { next });
const start = (p: Player) => call<BattleStartResponse>(p, API_ROUTES.battleStart);
const progress = (p: Player, id: number, deployments: DeployOrder[]) =>
  call<{ saved: number }>(p, buildingPath(API_ROUTES.battleDeployments, id), { deployments });
const finish = (p: Player, id: number, deployments: DeployOrder[], endTick: number) =>
  call<BattleFinishResponse>(p, buildingPath(API_ROUTES.battleFinish, id), { deployments, endTick });

async function begin(p: Player): Promise<ActiveBattleDto> {
  const s = await search(p);
  assert.equal(s.status, 200, s.body.message);
  const b = await start(p);
  assert.equal(b.status, 200, b.body.message);
  return b.body.battle;
}

/** Разрешённые клетки по краю поля боя — по кругу. */
function edgeCells(base: BattleBase): { x: number; y: number }[] {
  const lo = -BATTLE_MARGIN;
  const hi = base.gridSize + BATTLE_MARGIN - 1;
  const cells: { x: number; y: number }[] = [];
  for (let i = lo; i <= hi; i++) cells.push({ x: i, y: lo }, { x: hi, y: i }, { x: i, y: hi }, { x: lo, y: i });
  return cells.filter((c) => canDeployAt(base, c.x, c.y) === null);
}

function orders(base: BattleBase, troops: TroopType[], firstTick = 0, step = 7): DeployOrder[] {
  const cells = edgeCells(base);
  return troops.map((troop, i) => ({ troop, tick: firstTick + i * step, ...cells[(i * 11) % cells.length]! }));
}

/**
 * То, что насчитает клиент: бой вживую тем же движком, высадки на своём
 * тике, конец — сам или сдача на surrenderAt.
 */
function clientPlay(battle: ActiveBattleDto, list: DeployOrder[], surrenderAt?: number): { endTick: number; result: BattleResult; sent: DeployOrder[] } {
  const check = checkOrders(battle.base, battle.army, list);
  assert.ok(check.ok, JSON.stringify(check));
  const created = createBattle(battle.base, [], battle.seed, { endWhenNoTroops: false });
  assert.ok(created.ok);
  const s = created.state;
  let next = 0;
  while (!s.finished && (surrenderAt === undefined || s.tick < surrenderAt)) {
    while (next < check.deployments.length && check.deployments[next]!.tick === s.tick) {
      assert.ok(addDeployment(s, check.deployments[next]!).ok);
      next++;
      if (check.allTroopsUsed && next === check.deployments.length) s.endWhenNoTroops = true;
    }
    stepBattle(s);
  }
  return { endTick: s.tick, result: battleResult(s), sent: list.slice(0, next) };
}

const armyOf = async (p: Player) => (await me(p)).army.troops;

describe('бой с базой-ботом', { skip }, () => {
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

  it('поиск: цель той же ратуши ±1, повторный запрос — та же цель, «Следующая» стоит золота', async () => {
    const p = await newPlayer();
    const first = await search(p);
    assert.equal(first.status, 200, first.body.message);
    const target = first.body.target;
    assert.ok(Math.abs(target.townhallLevel - 1) <= 1);
    assert.ok(target.base.buildings.length > 0);
    assert.ok(target.lootPreview.gold > 0 && target.lootPreview.food > 0);
    assert.equal(target.nextCost, searchCost(1));
    assert.equal(first.body.player.resources.gold, STARTING_RESOURCES.gold, 'первый поиск бесплатный');

    const same = await search(p);
    assert.equal(same.body.target.id, target.id);
    const next = await search(p, true);
    assert.notEqual(next.body.target.id, target.id);
    assert.equal(next.body.player.resources.gold, STARTING_RESOURCES.gold - searchCost(1));

    await db!.query('UPDATE players SET gold = 0 WHERE id = $1', [p.id]);
    const poor = await search(p, true);
    assert.equal(poor.status, 422);
    assert.equal(poor.body.error, 'not_enough_resources');
  });

  it('без цели и без войск бой не начать', async () => {
    const p = await newPlayer([]);
    assert.equal((await start(p)).body.error, 'no_target');
    await search(p);
    assert.equal((await start(p)).body.error, 'no_troops');
  });

  it('подделанный лог отклоняется, бой остаётся открытым, ничего не начислено', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const base = battle.base;
    const before = await me(p);
    clock += BATTLE_MAX_TICKS * MS_PER_TICK;
    const cells = edgeCells(base);
    const at = cells[0]!;

    // Лишние войска: таранов в армии один.
    const extra = orders(base, ['ram', 'ram']);
    assert.equal((await finish(p, battle.id, extra, 100)).body.error, 'not_enough_troops');
    // Войска, которого нет в армии вовсе, — тоже.
    assert.equal((await finish(p, battle.id, [{ troop: 'dragon' as TroopType, tick: 0, ...at }], 100)).body.error, 'unknown_troop');
    // Высадка в запрещённой зоне (на ратуше).
    const th = base.buildings.find((b) => b.type === 'townhall')!;
    assert.equal((await finish(p, battle.id, [{ troop: 'warrior', tick: 0, x: th.x, y: th.y }], 100)).body.error, 'forbidden_zone');
    // Тики за лимитом боя и за концом боя.
    assert.equal((await finish(p, battle.id, [{ troop: 'warrior', tick: BATTLE_MAX_TICKS, ...at }], BATTLE_MAX_TICKS)).body.error, 'invalid_tick');
    assert.equal((await finish(p, battle.id, [{ troop: 'warrior', tick: 50, ...at }], 40)).body.error, 'invalid_tick');
    assert.equal((await finish(p, battle.id, [], BATTLE_MAX_TICKS + 1)).body.error, 'invalid_tick');
    // Тики не по порядку.
    assert.equal(
      (await finish(p, battle.id, [{ troop: 'warrior', tick: 10, ...at }, { troop: 'warrior', tick: 5, ...at }], 100)).body.error,
      'ticks_not_sorted',
    );

    const after = await me(p);
    assert.deepEqual(after.player.resources, before.player.resources);
    assert.deepEqual(after.army.troops, before.army.troops);
  });

  it('бой не может идти быстрее тиков', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const list = orders(battle.base, ['warrior'], 300);
    clock += 10_000; // 10 с = 100 тиков, а высадка на 300-м
    assert.equal((await progress(p, battle.id, list)).body.error, 'battle_too_fast');
    assert.equal((await finish(p, battle.id, [], 1800)).body.error, 'battle_too_fast');
    clock += 25_000;
    assert.equal((await progress(p, battle.id, list)).status, 200);
  });

  it('итог сервера совпадает с клиентским; войска списаны, добыча начислена; повторный finish не начисляет', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const troops: TroopType[] = ['ram', 'warrior', 'warrior', 'warrior', 'archer', 'archer', 'warrior', 'warrior', 'archer'];
    const client = clientPlay(battle, orders(battle.base, troops), 900);
    clock += client.endTick * MS_PER_TICK;

    const before = await me(p);
    const res = await finish(p, battle.id, client.sent, client.endTick);
    assert.equal(res.status, 200, res.body.message);
    const report = res.body.report;
    assert.equal(report.hash, client.result.hash);
    assert.equal(report.stars, client.result.stars);
    assert.equal(report.destruction, client.result.destruction);
    assert.deepEqual(report.loot, client.result.loot);
    assert.deepEqual(report.troopsUsed, client.result.troopsUsed);
    assert.deepEqual(report.troopsSurvived, client.result.troopsSurvived);
    assert.equal(report.reason, 'finish');

    const cap = townhallConfig(1)!.storage;
    const expected = {
      gold: Math.min(cap.gold, before.player.resources.gold + report.loot.gold),
      food: Math.min(cap.food, before.player.resources.food + report.loot.food),
    };
    assert.deepEqual(res.body.player.resources, expected);
    assert.deepEqual(report.gained, { gold: expected.gold - before.player.resources.gold, food: expected.food - before.player.resources.food });
    const used = (t: TroopType) => report.troopsUsed.filter((u) => u.troop === t).reduce((n, u) => n + u.count, 0);
    const count = (army: ArmyStack[], t: TroopType) => army.filter((s) => s.troop === t).reduce((n, s) => n + s.count, 0);
    for (const t of ['warrior', 'archer', 'ram'] as const) assert.equal(count(res.body.army.troops, t), count(ARMY, t) - used(t));

    const again = await finish(p, battle.id, client.sent, client.endTick);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.report, report);
    assert.deepEqual(again.body.player.resources, res.body.player.resources);
    assert.deepEqual(again.body.army.troops, res.body.army.troops);
    // Высадки после итога не принимаются.
    assert.equal((await progress(p, battle.id, client.sent)).body.error, 'battle_finished');
  });

  it('набор записанных боёв: сервер и клиент считают одинаково', async () => {
    const scenarios: { troops: TroopType[]; firstTick: number; step: number; surrender?: number }[] = [
      { troops: ['warrior', 'warrior', 'warrior'], firstTick: 0, step: 1 },
      { troops: ['archer', 'archer', 'archer', 'archer', 'archer', 'archer'], firstTick: 20, step: 15, surrender: 700 },
      { troops: ['ram', 'warrior', 'warrior', 'warrior', 'warrior', 'warrior', 'warrior'], firstTick: 5, step: 3 },
      { troops: ['warrior', 'archer', 'warrior', 'archer'], firstTick: 100, step: 40, surrender: 400 },
      { troops: [...Array(10).fill('warrior'), ...Array(6).fill('archer'), 'ram'] as TroopType[], firstTick: 0, step: 2 },
      { troops: [], firstTick: 0, step: 0, surrender: 50 },
    ];
    for (const [i, sc] of scenarios.entries()) {
      clock = T0 + i * 3_600_000;
      const p = await newPlayer();
      const battle = await begin(p);
      const client = clientPlay(battle, orders(battle.base, sc.troops, sc.firstTick, sc.step), sc.surrender);
      clock += client.endTick * MS_PER_TICK + 500;
      const res = await finish(p, battle.id, client.sent, client.endTick);
      assert.equal(res.status, 200, `сценарий ${i}: ${res.body.message}`);
      assert.equal(res.body.report.hash, client.result.hash, `сценарий ${i}`);
      assert.equal(res.body.report.endTick, client.result.endTick, `сценарий ${i}`);
      assert.deepEqual(res.body.report.loot, client.result.loot, `сценарий ${i}`);
    }
  });

  it('уже присланные высадки поменять нельзя', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const list = orders(battle.base, ['warrior', 'warrior']);
    clock += 5_000;
    assert.equal((await progress(p, battle.id, list)).status, 200);
    const changed = [{ ...list[0]!, tick: list[0]!.tick + 1 }, list[1]!];
    assert.equal((await finish(p, battle.id, changed, 40)).body.error, 'deployments_changed');
    // Отказаться от уже высаженных — тоже.
    assert.equal((await finish(p, battle.id, [], 40)).body.error, 'deployments_changed');
  });

  it('без итога за 5 минут бой закрывается с известными высадками', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const list = orders(battle.base, ['warrior', 'warrior', 'archer']);
    clock += 3_000;
    assert.equal((await progress(p, battle.id, list)).status, 200);

    clock = T0 + (BATTLE_FINISH_TIMEOUT_SECONDS - 1) * 1000;
    assert.deepEqual(await armyOf(p), ARMY, 'ещё не закрыт');
    clock = T0 + BATTLE_FINISH_TIMEOUT_SECONDS * 1000;
    const army = await armyOf(p);
    assert.deepEqual(army, [
      { troop: 'warrior', level: 1, count: 8 },
      { troop: 'archer', level: 1, count: 5 },
      { troop: 'ram', level: 1, count: 1 },
    ]);
    const { rows } = await db!.query<{ status: string; end_reason: string }>('SELECT status, end_reason FROM battles WHERE id = $1', [battle.id]);
    assert.deepEqual(rows[0], { status: 'finished', end_reason: 'timeout' });
    // Поздний finish получает посчитанный итог, но ничего не меняет.
    const late = await finish(p, battle.id, list, 100);
    assert.equal(late.body.report.reason, 'timeout');
    assert.deepEqual(late.body.army.troops, army);
  });

  it('без высадок — поражение без потерь; новый поиск закрывает брошенный бой', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    clock += BATTLE_FINISH_TIMEOUT_SECONDS * 1000;
    const base = await me(p);
    assert.deepEqual(base.army.troops, ARMY);
    assert.deepEqual(base.player.resources, STARTING_RESOURCES);
    const { rows } = await db!.query<{ result: { stars: number; destruction: number } }>('SELECT result FROM battles WHERE id = $1', [battle.id]);
    assert.equal(rows[0]!.result.stars, 0);
    assert.equal(rows[0]!.result.destruction, 0);

    const second = await begin(p);
    clock += 2_000;
    await progress(p, second.id, orders(second.base, ['warrior']));
    const s = await search(p);
    assert.equal(s.status, 200);
    assert.notEqual(s.body.target.id, second.id);
    const closed = await db!.query<{ end_reason: string }>('SELECT end_reason FROM battles WHERE id = $1', [second.id]);
    assert.equal(closed.rows[0]!.end_reason, 'abandoned');
    assert.equal(s.body.army.troops.find((t) => t.troop === 'warrior')!.count, 9);
  });

  it('бои хранятся: база, seed, армия и высадки', async () => {
    const p = await newPlayer();
    const battle = await begin(p);
    const list = orders(battle.base, ['warrior']);
    clock += 3_000;
    await finish(p, battle.id, list, 30);
    const { rows } = await db!.query('SELECT base, seed, army, deployments, end_tick FROM battles WHERE id = $1', [battle.id]);
    assert.deepEqual(rows[0], { base: battle.base, seed: battle.seed, army: ARMY, deployments: list, end_tick: 30 });
  });
});
