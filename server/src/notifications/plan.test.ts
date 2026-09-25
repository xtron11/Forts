import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fillTime, PRODUCERS, type PlacedBuilding } from '@forts/shared';
import { composeNotification, notificationStartParam } from './messages';
import { planNotifications } from './plan';
import { diffNotifications, type NotificationRow } from './store';

const T0 = Date.UTC(2026, 8, 25, 12, 0);
const MIN = 60_000;
const mine1 = PRODUCERS.goldmine.levels[0]!;

let nextId = 1;
function building(type: PlacedBuilding['type'], patch: Partial<PlacedBuilding> = {}): PlacedBuilding {
  return { id: nextId++, type, x: 0, y: 0, level: 1, finishAt: null, collectedAt: T0, stored: 0, ...patch };
}

const plan = (buildings: PlacedBuilding[], since = T0, disabled: string[] = []) =>
  planNotifications({ buildings, since, canMessage: true, disabled });

describe('план уведомлений', () => {
  it('build_done — на finishAt каждой идущей стройки', () => {
    const b = building('barracks', { level: 1, finishAt: T0 + 5 * MIN });
    assert.deepEqual(plan([building('townhall'), b]), [
      { type: 'build_done', key: String(b.id), eventAt: T0 + 5 * MIN, payload: { buildingId: b.id, building: 'barracks', level: 2 } },
    ]);
  });

  it('о том, что игрок уже видел, не уведомляем', () => {
    const b = building('barracks', { finishAt: T0 + 5 * MIN });
    assert.deepEqual(plan([b], T0 + 5 * MIN), []);
    const full = building('goldmine', { stored: mine1.capacity });
    assert.deepEqual(plan([full]), []);
  });

  it('storage_full — одно на ресурс, по ближайшей заполняющейся шахте', () => {
    const slow = building('goldmine');
    const fast = building('goldmine', { stored: mine1.capacity / 2 });
    const farm = building('farm');
    const planned = plan([slow, fast, farm]);
    assert.deepEqual(
      planned.map((p) => [p.type, p.key, p.eventAt]),
      [
        ['storage_full', 'gold', fillTime(fast)],
        ['storage_full', 'food', fillTime(farm)],
      ],
    );
  });

  it('шахта, уже полная к визиту, не мешает уведомить о другой', () => {
    const full = building('goldmine', { stored: mine1.capacity });
    const empty = building('goldmine');
    assert.deepEqual(plan([full, empty]).map((p) => p.eventAt), [fillTime(empty)]);
  });

  it('выключенные типы и запрет писать — пусто', () => {
    const bs = [building('goldmine'), building('farm', { level: 0, finishAt: T0 + MIN })];
    assert.deepEqual(plan(bs, T0, ['build_done', 'storage_full']), []);
    assert.deepEqual(planNotifications({ buildings: bs, since: T0, canMessage: false, disabled: [] }), []);
    assert.deepEqual(new Set(plan(bs, T0, ['storage_full']).map((p) => p.type)), new Set(['build_done']));
  });

  it('army_ready — одно, на готовность последнего юнита очереди', () => {
    const training = [{ finishAt: T0 + MIN }, { finishAt: T0 + 3 * MIN }, { finishAt: T0 + 2 * MIN }];
    const planned = planNotifications({ buildings: [], training, since: T0, canMessage: true, disabled: [] });
    assert.deepEqual(planned, [{ type: 'army_ready', key: 'army', eventAt: T0 + 3 * MIN, payload: { units: 3 } }]);
    // Игрок уже видел готовую армию или выключил тип — не уведомляем.
    assert.deepEqual(planNotifications({ buildings: [], training, since: T0 + 3 * MIN, canMessage: true, disabled: [] }), []);
    assert.deepEqual(planNotifications({ buildings: [], training, since: T0, canMessage: true, disabled: ['army_ready'] }), []);
  });
});

describe('дедупликация: таблица против плана', () => {
  const row = (patch: Partial<NotificationRow>): NotificationRow => ({
    id: 1,
    type: 'storage_full',
    key: 'gold',
    event_at: new Date(T0),
    send_at: new Date(T0),
    payload: { resource: 'gold' },
    status: 'pending',
    attempts: 0,
    ...patch,
  });
  const planned = { type: 'storage_full' as const, key: 'gold', eventAt: T0, payload: { resource: 'gold' as const } };

  it('новое событие — вставка', () => {
    assert.deepEqual(diffNotifications([], [planned]), { insert: [planned], reset: [], cancel: [] });
  });

  it('то же событие уже ждёт или отправлено — ничего (в том числе отложенный send_at не сбрасывается)', () => {
    const empty = { insert: [], reset: [], cancel: [] };
    assert.deepEqual(diffNotifications([row({ send_at: new Date(T0 + 60 * MIN) })], [planned]), empty);
    assert.deepEqual(diffNotifications([row({ status: 'sent' })], [planned]), empty);
    assert.deepEqual(diffNotifications([row({ status: 'failed' })], [planned]), empty);
  });

  it('новое время события — та же строка снова ждёт отправки', () => {
    const moved = { ...planned, eventAt: T0 + 30 * MIN };
    assert.deepEqual(diffNotifications([row({ status: 'sent' })], [moved]).reset, [{ id: 1, planned: moved }]);
    assert.deepEqual(diffNotifications([row({})], [moved]).reset, [{ id: 1, planned: moved }]);
    assert.deepEqual(diffNotifications([row({ status: 'cancelled' })], [planned]).reset, [{ id: 1, planned }]);
  });

  it('событие пропало из плана — pending отменяется, отправленное остаётся', () => {
    assert.deepEqual(diffNotifications([row({ id: 7 })], []).cancel, [7]);
    assert.deepEqual(diffNotifications([row({ status: 'sent' })], []).cancel, []);
  });
});

describe('текст уведомления', () => {
  const built = { type: 'build_done' as const, payload: { buildingId: 1, building: 'goldmine' as const, level: 1 } };
  const upgraded = { type: 'build_done' as const, payload: { buildingId: 2, building: 'farm' as const, level: 3 } };
  const full = { type: 'storage_full' as const, payload: { resource: 'food' as const } };

  it('фразы чередуются', () => {
    const texts = [0, 1, 2].map((v) => composeNotification('ru', [upgraded], v));
    assert.equal(new Set(texts).size, 3);
    assert.ok(texts.every((s) => s.includes('Ферма') && s.includes('3')));
    assert.equal(composeNotification('ru', [upgraded], 3), texts[0]);
    assert.match(composeNotification('en', [built], 0), /Gold Mine/);
  });

  it('несколько событий — одно сообщение со списком', () => {
    const text = composeNotification('ru', [built, full], 0);
    assert.equal(text.split('\n').length, 3);
    assert.match(text, /Шахта/);
    assert.match(text, /фермы/);
  });

  it('параметр кнопки', () => {
    assert.equal(notificationStartParam([built]), 'notif_build_done');
    assert.equal(notificationStartParam([built, upgraded]), 'notif_build_done');
    assert.equal(notificationStartParam([built, full]), 'notif_digest');
  });
});
