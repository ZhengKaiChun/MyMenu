import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.mjs';
test('SMS verification is expiring, limited, single-use and encrypted', async (t) => {
  let sent = [];
  const config = {
    production: false,
    database: {},
    origin: 'http://127.0.0.1:3000',
    mediaKey: 'x'.repeat(32),
    pepper: 'p'.repeat(32),
    phoneKey: 'ab'.repeat(32),
    mediaDir: '.runtime/test-media',
    wechatSecret: '',
    allowDevAuth: false,
  };
  const { app, db } = await buildApp({
    config,
    logger: false,
    smsSender: async (phone, code) => sent.push({ phone, code }),
  });
  t.after(() => app.close());
  let ip = 1;
  async function call(url, body, user) {
    let r = await app.inject({
      method: 'POST',
      url,
      remoteAddress: '127.0.0.' + ip++,
      headers: user ? { authorization: 'Bearer ' + user.token } : {},
      payload: body,
    });
    return { status: r.statusCode, data: r.json() };
  }
  const number = '13800138000';
  let first = await call('/auth/sms/send', { phone: number });
  assert.equal(first.status, 200);
  assert.ok(!JSON.stringify(first.data).includes(sent[0].code));
  assert.equal((await call('/auth/sms/send', { phone: number })).status, 429);
  let raw = (await db.query('SELECT * FROM sms_challenges')).rows[0];
  assert.notEqual(raw.code_hash, sent[0].code);
  assert.ok(!JSON.stringify(raw).includes(number));
  const actual = sent[0].code;
  for (let i = 0; i < 5; i++)
    assert.equal((await call('/auth/sms', { phone: number, code: '000000' })).status, 401);
  assert.equal((await call('/auth/sms', { phone: number, code: actual })).status, 401);
  assert.equal((await db.query('SELECT attempts FROM sms_challenges')).rows[0].attempts, 5);
  await db.query("UPDATE sms_challenges SET sent_at=now()-interval '2 minutes'");
  await call('/auth/sms/send', { phone: number });
  let login = await call('/auth/sms', { phone: number, code: sent.at(-1).code });
  assert.equal(login.status, 200);
  let user = (await db.query('SELECT * FROM users WHERE id=$1', [login.data.user.id])).rows[0];
  assert.ok(user.phone_cipher.startsWith('v1:'));
  assert.ok(!user.phone_cipher.includes(number));
  assert.notEqual(user.phone_hash, number);
  assert.equal((await call('/auth/sms', { phone: number, code: sent.at(-1).code })).status, 401);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  let me = await app.inject({
    url: '/me',
    headers: { authorization: 'Bearer ' + login.data.token },
  });
  assert.equal(me.statusCode, 401);
});
