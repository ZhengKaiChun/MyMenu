import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';

test('photo signing has its own browsing allowance while general requests retain a Chinese limit', async (t) => {
  const { app, db } = await buildApp({
    logger: false,
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'm'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
  });
  t.after(() => app.close());
  const registration = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'media_browse', password: 'long-safe-password' },
  });
  assert.equal(registration.statusCode, 200);
  const user = registration.json();
  const mid = randomUUID();
  await db.query('INSERT INTO media(id,owner_id,filename,mime,size) VALUES($1,$2,$3,$4,$5)', [
    mid,
    user.user.id,
    mid + '.jpg',
    'image/jpeg',
    100,
  ]);
  const headers = { authorization: 'Bearer ' + user.token };
  for (let i = 0; i < 110; i++) {
    const signed = await app.inject({
      method: 'POST',
      url: '/media/' + mid + '/url',
      headers,
      payload: {},
    });
    assert.equal(signed.statusCode, 200, 'photo request ' + i + ': ' + signed.body);
  }
  assert.equal((await app.inject({ url: '/me', headers })).statusCode, 200);
  let limited;
  for (let i = 0; i < 110; i++) {
    const response = await app.inject({ url: '/health' });
    if (response.statusCode === 429) {
      limited = response;
      break;
    }
  }
  assert.equal(limited?.statusCode, 429);
  assert.match(limited.json().error.message, /操作有点快/);
});
