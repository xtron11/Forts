import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterQuietHours, earliestSendTime, shouldAskWriteAccess, timezoneOffsetMs } from './policy';
import { NOTIFY_TIMING as T, WRITE_ACCESS_REPROMPT_MS } from './timing';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 25.09.2026 12:00 UTC = 15:00 по Москве. */
const NOON = Date.UTC(2026, 8, 25, 12, 0);
const msk = (h: number, m = 0, day = 25) => Date.UTC(2026, 8, day, h - 3, m);

describe('тихие часы 23:00–08:00 по времени игрока', () => {
  it('смещение пояса', () => {
    assert.equal(timezoneOffsetMs('Europe/Moscow', NOON), 3 * HOUR);
    assert.equal(timezoneOffsetMs(null, NOON), 0);
    assert.equal(timezoneOffsetMs('Not/AZone', NOON), 0);
  });

  it('днём — сразу', () => {
    assert.equal(afterQuietHours(msk(15), 'Europe/Moscow', T), msk(15));
    assert.equal(afterQuietHours(msk(22, 59), 'Europe/Moscow', T), msk(22, 59));
    assert.equal(afterQuietHours(msk(8), 'Europe/Moscow', T), msk(8));
  });

  it('вечером после 23:00 — на 08:00 следующего дня', () => {
    assert.equal(afterQuietHours(msk(23), 'Europe/Moscow', T), msk(8, 0, 26));
    assert.equal(afterQuietHours(msk(23, 45), 'Europe/Moscow', T), msk(8, 0, 26));
  });

  it('ночью до 08:00 — на 08:00 того же дня', () => {
    assert.equal(afterQuietHours(msk(3, 10), 'Europe/Moscow', T), msk(8));
    assert.equal(afterQuietHours(msk(7, 59), 'Europe/Moscow', T), msk(8));
  });

  it('без пояса — по UTC', () => {
    assert.equal(afterQuietHours(Date.UTC(2026, 8, 25, 2), null, T), Date.UTC(2026, 8, 25, 8));
  });

  it('переход на летнее время ночью: 08:00 по новому времени', () => {
    // В Европе/Берлине 29.03.2026 в 02:00 часы переводят на 03:00 (UTC+1 → UTC+2).
    const night = Date.UTC(2026, 2, 28, 23, 30); // 00:30 по Берлину
    assert.equal(afterQuietHours(night, 'Europe/Berlin', T), Date.UTC(2026, 2, 29, 6, 0));
  });
});

describe('когда можно написать игроку', () => {
  const base = { now: NOON, lastSeenAt: NOON - HOUR, sentAt: [] as number[], timezone: 'Europe/Moscow' };

  it('ничего не мешает — сейчас', () => {
    assert.equal(earliestSendTime(base, T), NOON);
  });

  it('игрок был в игре меньше 2 минут назад — через 2 минуты после визита', () => {
    assert.equal(earliestSendTime({ ...base, lastSeenAt: NOON - 30_000 }, T), NOON - 30_000 + 2 * MIN);
  });

  it('минимум 30 минут между сообщениями', () => {
    assert.equal(earliestSendTime({ ...base, sentAt: [NOON - 10 * MIN] }, T), NOON + 20 * MIN);
    assert.equal(earliestSendTime({ ...base, sentAt: [NOON - 31 * MIN] }, T), NOON);
  });

  it('не больше 4 в сутки: пятое — когда самое старое из четырёх выйдет из суток', () => {
    const sent = [NOON - 23 * HOUR, NOON - 10 * HOUR, NOON - 5 * HOUR, NOON - 2 * HOUR];
    assert.equal(earliestSendTime({ ...base, sentAt: sent }, T), NOON + HOUR);
    // Три за сутки и одно давнее — можно.
    assert.equal(earliestSendTime({ ...base, sentAt: [NOON - 25 * HOUR, ...sent.slice(1)] }, T), NOON);
  });

  it('лимит переносит в тихие часы — тогда утром', () => {
    // Можно было бы в 23:30 по Москве, но это тихие часы → 08:00.
    const now = msk(22);
    const sent = [msk(23, 30, 24), msk(10), msk(14), msk(18)];
    assert.equal(earliestSendTime({ ...base, now, lastSeenAt: now - DAY, sentAt: sent }, T), msk(8, 0, 26));
  });
});

describe('предложение уведомлений в игре', () => {
  const built = [{ type: 'townhall' }, { type: 'goldmine' }];

  it('после первой постройки, если бот не может писать', () => {
    assert.equal(shouldAskWriteAccess({ canMessage: false, writeAccessAskedAt: null }, built, NOON), true);
    assert.equal(shouldAskWriteAccess({ canMessage: false, writeAccessAskedAt: null }, [{ type: 'townhall' }], NOON), false);
    assert.equal(shouldAskWriteAccess({ canMessage: true, writeAccessAskedAt: null }, built, NOON), false);
  });

  it('после отказа — не чаще раза в неделю', () => {
    assert.equal(shouldAskWriteAccess({ canMessage: false, writeAccessAskedAt: NOON - DAY }, built, NOON), false);
    assert.equal(shouldAskWriteAccess({ canMessage: false, writeAccessAskedAt: NOON - WRITE_ACCESS_REPROMPT_MS }, built, NOON), true);
  });
});
