import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { validateInitData } from './initData';

const BOT_TOKEN = '123456789:TEST-token_for-unit-tests';
const NOW = new Date('2026-09-25T12:00:00Z');
const nowSec = NOW.getTime() / 1000;
const USER = { id: 42, first_name: 'Вася', last_name: 'Пупкин', language_code: 'ru' };

/**
 * Подписывает initData, считая HMAC независимо от проверяемого кода —
 * прямо по описанию из документации Telegram.
 */
function makeInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function validFields(authDate = nowSec - 60): Record<string, string> {
  return {
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(USER),
    auth_date: String(authDate),
    signature: 'abc123',
  };
}

describe('validateInitData', () => {
  it('принимает верную подпись и возвращает пользователя', () => {
    const result = validateInitData(makeInitData(validFields()), BOT_TOKEN, { now: NOW });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(result.user, USER);
    assert.equal(result.authDate.getTime(), (nowSec - 60) * 1000);
  });

  it('отклоняет подделанные данные пользователя', () => {
    const params = new URLSearchParams(makeInitData(validFields()));
    params.set('user', JSON.stringify({ ...USER, id: 1 }));
    assert.deepEqual(validateInitData(params.toString(), BOT_TOKEN, { now: NOW }), { ok: false, reason: 'bad_signature' });
  });

  it('отклоняет подделанный hash', () => {
    const params = new URLSearchParams(makeInitData(validFields()));
    const hash = params.get('hash')!;
    params.set('hash', (hash[0] === '0' ? '1' : '0') + hash.slice(1));
    assert.deepEqual(validateInitData(params.toString(), BOT_TOKEN, { now: NOW }), { ok: false, reason: 'bad_signature' });
  });

  it('отклоняет данные, подписанные другим ботом', () => {
    const initData = makeInitData(validFields(), '987654321:another-bot-token');
    assert.deepEqual(validateInitData(initData, BOT_TOKEN, { now: NOW }), { ok: false, reason: 'bad_signature' });
  });

  it('отклоняет добавленное поле', () => {
    const initData = makeInitData(validFields()) + '&start_param=hack';
    assert.deepEqual(validateInitData(initData, BOT_TOKEN, { now: NOW }), { ok: false, reason: 'bad_signature' });
  });

  it('отклоняет просроченные данные (старше 24 часов)', () => {
    const initData = makeInitData(validFields(nowSec - 24 * 60 * 60 - 1));
    assert.deepEqual(validateInitData(initData, BOT_TOKEN, { now: NOW }), { ok: false, reason: 'expired' });
  });

  it('принимает данные возрастом почти 24 часа', () => {
    const initData = makeInitData(validFields(nowSec - 24 * 60 * 60 + 5));
    assert.equal(validateInitData(initData, BOT_TOKEN, { now: NOW }).ok, true);
  });

  it('отклоняет auth_date из будущего', () => {
    const initData = makeInitData(validFields(nowSec + 3600));
    assert.deepEqual(validateInitData(initData, BOT_TOKEN, { now: NOW }), { ok: false, reason: 'expired' });
  });

  it('отклоняет данные без hash и мусор', () => {
    for (const bad of ['', 'garbage', new URLSearchParams(validFields()).toString(), 'hash=zz']) {
      assert.deepEqual(validateInitData(bad, BOT_TOKEN, { now: NOW }), { ok: false, reason: 'malformed' });
    }
  });

  it('отклоняет подписанные данные без пользователя', () => {
    const { user: _user, ...fields } = validFields();
    assert.deepEqual(validateInitData(makeInitData(fields), BOT_TOKEN, { now: NOW }), { ok: false, reason: 'malformed' });
  });
});
