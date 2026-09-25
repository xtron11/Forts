/**
 * Уведомления целиком: игровые запросы пересчитывают очередь, воркер
 * отправляет через подменённый отправитель. Настоящий Postgres (forts_test).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { API_ROUTES, buildingPath, fillTime, PRODUCERS, type BaseSnapshot, type PlaceBuildingResponse } from '@forts/shared';
import { buildApp } from './app';
import type { NotificationSender, SendResult } from './notifications/sender';
import { NOTIFY_TIMING } from './notifications/timing';
import { processDueNotifications } from './notifications/worker';
import { loginPlayer, startFromBot } from './players';
import { openTestDb, TEST_CONFIG } from './testing';

const db = await openTestDb();
const skip = db ? false : 'Postgres недоступен (npm run db:up) — тесты с базой пропущены';

/** 12:00 UTC — не тихие часы для игроков без часового пояса. */
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const mine1 = PRODUCERS.goldmine.levels[0]!;
const WEBAPP = 'https://forts.example';

let clock = T0;
let app: FastifyInstance;
let nextTelegramId = 1000;

/** Отправитель-заглушка: запоминает сообщения, отвечает очередным результатом. */
const sent: { chatId: number; text: string; url?: string }[] = [];
let nextResults: SendResult[] = [];
const sender: NotificationSender = {
  async send(chatId, text, button) {
    const result = nextResults.shift() ?? { ok: true };
    if (result.ok) sent.push({ chatId, text, url: button?.url });
    return result;
  },
};
const tick = () => processDueNotifications({ db: db!, sender, timing: NOTIFY_TIMING, webappUrl: WEBAPP, now: () => clock });

interface Player {
  id: number;
  telegramId: number;
  token: string;
}

async function newPlayer(opts: { allows?: boolean; timezone?: string } = {}): Promise<Player> {
  const telegramId = nextTelegramId++;
  const id = await loginPlayer(
    db!,
    { telegramId, name: 'Test', languageCode: 'ru', allowsWriteToPm: opts.allows ?? true, timezone: opts.timezone },
    clock,
  );
  return { id, telegramId, token: app.jwt.sign({ sub: String(id) }) };
}

async function call<T = BaseSnapshot>(p: Player, method: 'GET' | 'POST', url: string, body?: object) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, payload: body });
  return res.json() as T;
}
const me = (p: Player) => call(p, 'GET', API_ROUTES.me);
const place = (p: Player, type: string, x: number, y: number) => call<PlaceBuildingResponse>(p, 'POST', API_ROUTES.buildings, { type, x, y });
const collect = (p: Player, id: number) => call(p, 'POST', buildingPath(API_ROUTES.collectBuilding, id));

interface Row {
  type: string;
  key: string;
  event_at: Date;
  send_at: Date;
  status: string;
}
async function rows(p: Player): Promise<Row[]> {
  const res = await db!.query<Row>('SELECT type, key, event_at, send_at, status FROM notifications WHERE player_id = $1 ORDER BY type, key', [p.id]);
  return res.rows;
}
const pending = async (p: Player) => (await rows(p)).filter((r) => r.status === 'pending');

async function events(p: Player, type: string): Promise<number> {
  const res = await db!.query('SELECT 1 FROM events WHERE player_id = $1 AND type = $2', [p.id, type]);
  return res.rowCount ?? 0;
}

describe('уведомления', { skip }, () => {
  before(async () => {
    await db!.query('TRUNCATE players RESTART IDENTITY CASCADE');
    app = await buildApp({ config: TEST_CONFIG, db: db!, now: () => clock });
  });

  after(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    // Очередь общая: уведомления игроков из прошлых тестов не должны мешать.
    await db!.query(`UPDATE notifications SET status = 'cancelled' WHERE status = 'pending'`);
    clock = T0;
    sent.length = 0;
    nextResults = [];
  });

  it('постройка планирует build_done на finish_at и storage_full на заполнение', async () => {
    const p = await newPlayer();
    const res = await place(p, 'goldmine', 0, 0);
    const mine = res.building;
    const all = await rows(p);
    assert.deepEqual(
      all.map((r) => [r.type, r.key, r.event_at.getTime(), r.status]),
      [
        ['build_done', String(mine.id), mine.finishAt, 'pending'],
        ['storage_full', 'gold', fillTime(mine), 'pending'],
      ],
    );
  });

  it('без разрешения писать — ничего не планируется, игре предлагается спросить', async () => {
    const p = await newPlayer({ allows: false });
    const res = await place(p, 'goldmine', 0, 0);
    assert.deepEqual(await rows(p), []);
    assert.equal(res.player.askWriteAccess, true);

    const answered = await call(p, 'POST', API_ROUTES.writeAccess, { granted: false });
    assert.equal(answered.player.askWriteAccess, false);
    assert.deepEqual(await rows(p), []);

    const granted = await call(p, 'POST', API_ROUTES.writeAccess, { granted: true });
    assert.equal(granted.player.askWriteAccess, false);
    assert.equal((await pending(p)).length, 2, 'после разрешения уведомления запланированы');
  });

  it('сбор пересчитывает storage_full; повторные запросы не создают дублей', async () => {
    const p = await newPlayer();
    const mineId = (await place(p, 'goldmine', 0, 0)).building.id;
    clock += mine1.buildSeconds * SEC + 30 * MIN;
    await me(p);
    await me(p);
    const before = (await rows(p)).filter((r) => r.type === 'storage_full');
    assert.equal(before.length, 1);

    const after = await collect(p, mineId);
    const mine = after.buildings.find((b) => b.id === mineId)!;
    const now = (await rows(p)).filter((r) => r.type === 'storage_full');
    assert.equal(now.length, 1);
    assert.equal(now[0]!.event_at.getTime(), fillTime(mine));
    assert.ok(now[0]!.event_at > before[0]!.event_at, 'заполнение сдвинулось на позже');
    // build_done уже в прошлом — игрок видел готовую шахту.
    assert.equal((await rows(p)).find((r) => r.type === 'build_done')!.status, 'cancelled');
  });

  it('воркер отправляет готовое, с кнопкой и параметром; повторно не отправляет', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0);
    const barracksDone = T0 + 20 * SEC;
    clock = barracksDone + 3 * MIN;

    const res = await tick();
    assert.equal(res.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, p.telegramId);
    assert.match(sent[0]!.text, /Казарма/);
    assert.equal(sent[0]!.url, `${WEBAPP}?startapp=notif_build_done`);
    assert.equal((await rows(p)).find((r) => r.type === 'build_done')!.status, 'sent');
    assert.equal(await events(p, 'notification_sent'), 1);

    clock += 5 * MIN;
    assert.equal((await tick()).sent, 0);
    assert.equal(sent.length, 1);
  });

  it('игрок заходил после события — уведомление отменяется', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0);
    clock = T0 + 30 * SEC;
    await me(p); // видит готовую казарму
    clock = T0 + 5 * MIN;
    await tick();
    assert.equal(sent.length, 0);
    assert.equal((await rows(p)).find((r) => r.type === 'build_done')!.status, 'cancelled');
  });

  it('игрок в игре последние 2 минуты — откладывается', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0);
    clock = T0 + 10 * SEC;
    await me(p); // ещё строится, игрок в игре
    clock = T0 + 60 * SEC;
    const res = await tick();
    assert.equal(res.deferred, 1);
    assert.equal(sent.length, 0);
    const row = (await pending(p)).find((r) => r.type === 'build_done')!;
    assert.equal(row.send_at.getTime(), T0 + 10 * SEC + 2 * MIN);

    clock = row.send_at.getTime();
    assert.equal((await tick()).sent, 1);
  });

  it('близкие события — одним сообщением', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0); // 20 с
    await place(p, 'goldmine', 8, 0); // 10 с
    clock = T0 + 5 * MIN;
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text.split('\n').length, 3);
    assert.equal((await rows(p)).filter((r) => r.status === 'sent').length, 2);
  });

  it('тихие часы: ночное событие уходит утром', async () => {
    // 12:00 UTC — полночь на Камчатке (UTC+12); утро там — 20:00 UTC.
    const p = await newPlayer({ timezone: 'Asia/Kamchatka' });
    await place(p, 'barracks', 0, 0);
    clock = T0 + 5 * MIN;
    await tick();
    assert.equal(sent.length, 0);
    const morning = Date.UTC(2026, 8, 25, 20, 0);
    assert.equal((await pending(p)).find((r) => r.type === 'build_done')!.send_at.getTime(), morning);
    clock = morning;
    await tick();
    assert.equal(sent.length, 1);
  });

  it('не больше 4 в сутки и 30 минут между сообщениями', async () => {
    const p = await newPlayer();
    for (const hoursAgo of [20, 15, 10, 5]) {
      await db!.query(`INSERT INTO events (player_id, type, created_at) VALUES ($1, 'notification_sent', $2)`, [p.id, new Date(T0 - hoursAgo * HOUR)]);
    }
    await place(p, 'barracks', 0, 0);
    clock = T0 + 5 * MIN;
    await tick();
    assert.equal(sent.length, 0);
    assert.equal((await pending(p))[0]!.send_at.getTime(), T0 - 20 * HOUR + 24 * HOUR);

    clock = T0;
    const q = await newPlayer();
    await db!.query(`INSERT INTO events (player_id, type, created_at) VALUES ($1, 'notification_sent', $2)`, [q.id, new Date(T0 - 10 * MIN)]);
    await place(q, 'barracks', 0, 0);
    clock = T0 + 5 * MIN;
    await tick();
    assert.equal((await pending(q)).find((r) => r.type === 'build_done')!.send_at.getTime(), T0 + 20 * MIN);
  });

  it('403 — бот заблокирован: can_message = false до следующего /start', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0);
    clock = T0 + 5 * MIN;
    nextResults = [{ ok: false, kind: 'blocked', message: 'Forbidden: bot was blocked by the user' }];
    await tick();
    const player = await db!.query('SELECT can_message, bot_blocked_at FROM players WHERE id = $1', [p.id]);
    assert.equal(player.rows[0].can_message, false);
    assert.ok(player.rows[0].bot_blocked_at);
    assert.deepEqual(await pending(p), []);

    // Вход с allows_write_to_pm не снимает блокировку — только /start.
    await loginPlayer(db!, { telegramId: p.telegramId, name: 'Test', languageCode: 'ru', allowsWriteToPm: true }, clock);
    await place(p, 'goldmine', 8, 0);
    assert.deepEqual(await pending(p), []);

    await startFromBot(db!, { telegramId: p.telegramId, name: 'Test', languageCode: 'ru' }, undefined, clock);
    assert.ok((await pending(p)).length > 0, 'после /start снова планируется');
  });

  it('429 — откладывается на retry_after, воркер ставит паузу', async () => {
    const p = await newPlayer();
    await place(p, 'barracks', 0, 0);
    clock = T0 + 5 * MIN;
    nextResults = [{ ok: false, kind: 'rate_limited', retryAfterSec: 7 }];
    const res = await tick();
    assert.equal(res.pauseUntil, clock + 7 * SEC);
    assert.equal((await pending(p)).find((r) => r.type === 'build_done')!.send_at.getTime(), clock + 7 * SEC);
  });

  it('вход по кнопке уведомления и источник прихода записываются', async () => {
    const telegramId = nextTelegramId++;
    const id = await startFromBot(db!, { telegramId, name: 'Ad', languageCode: 'en' }, 'ads_vk', clock);
    await loginPlayer(db!, { telegramId, name: 'Ad', languageCode: 'en', startParam: 'other_source' }, clock);
    await loginPlayer(db!, { telegramId, name: 'Ad', languageCode: 'en', startParam: 'notif_build_done' }, clock);
    const player = await db!.query('SELECT source, can_message FROM players WHERE id = $1', [id]);
    assert.deepEqual(player.rows[0], { source: 'ads_vk', can_message: true });
    const ev = await db!.query('SELECT type, data FROM events WHERE player_id = $1 ORDER BY id', [id]);
    assert.deepEqual(
      ev.rows.map((r) => r.type),
      ['bot_start', 'login', 'login', 'notification_open'],
    );
    assert.deepEqual(ev.rows[3].data, { type: 'build_done' });
  });
});
