import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';
import { deliverNotifications } from '../src/modules/notifications/wechat.mjs';
test('subscription delivery consumes one-time grant, never forges permission and retains station notifications', async (t) => {
  const config = {
    production: false,
    database: {},
    origin: 'http://127.0.0.1:3000',
    mediaKey: 'm'.repeat(32),
    pepper: 'p'.repeat(32),
    mediaDir: '.runtime/test-media',
    wechatSecret: 'test-not-a-real-provider-secret',
    subscription: { templateId: 'test-approved-template', fields: { thing1: '{{body}}' } },
  };
  const { app, db } = await buildApp({ config, logger: false });
  t.after(() => app.close());
  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'notification_user', password: 'test-notification-password' },
  });
  const auth = register.json(),
    headers = { authorization: 'Bearer ' + auth.token };
  const fakeGrant = await app.inject({
    method: 'POST',
    url: '/notifications/subscribe',
    headers,
    payload: { templateId: config.subscription.templateId, accepted: true },
  });
  assert.equal(fakeGrant.statusCode, 409);
  await db.query("INSERT INTO identities(provider,subject,user_id) VALUES('wechat',$1,$2)", [
    'test-openid',
    auth.user.id,
  ]);
  let grant = await app.inject({
    method: 'POST',
    url: '/notifications/subscribe',
    headers,
    payload: { templateId: config.subscription.templateId, accepted: true },
  });
  assert.equal(grant.statusCode, 200);
  for (let i = 0; i < 2; i++)
    await db.query(
      "INSERT INTO notifications(id,user_id,type,body) VALUES($1,$2,'order.pending','您小猪发来了一条吃饭申请')",
      [randomUUID(), auth.user.id],
    );
  let calls = [];
  await deliverNotifications(db, config, async (n) => {
    calls.push(n);
    return 0;
  });
  assert.equal(calls.length, 1);
  assert.equal((await db.query('SELECT remaining FROM subscription_grants')).rows[0].remaining, 0);
  const rows = (await db.query('SELECT delivery_status FROM notifications')).rows;
  assert.ok(rows.some((n) => n.delivery_status === 'delivered'));
  assert.ok(rows.some((n) => n.delivery_status === 'skipped'));
  const station = await app.inject({ url: '/notifications', headers });
  assert.equal(station.json().length, 2);
  await deliverNotifications(db, config, async () => {
    throw Error('must not redeliver');
  });
  assert.equal(calls.length, 1);
});
