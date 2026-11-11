import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.mjs';
import { randomUUID } from 'node:crypto';
test('menu draft saves atomically, supports minimal recipes and shared inventory without recipe disclosure', async (t) => {
  const { app } = await buildApp({
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
  async function call(method, url, u, body) {
    const r = await app.inject({
      method,
      url,
      headers: u ? { authorization: 'Bearer ' + u.token, 'idempotency-key': randomUUID() } : {},
      payload: body,
    });
    return { status: r.statusCode, data: r.json() };
  }
  const cook = (
      await call('POST', '/auth/register', null, {
        username: 'draft_cook',
        password: 'test-draft-password',
      })
    ).data,
    eater = (
      await call('POST', '/auth/register', null, {
        username: 'draft_eater',
        password: 'test-draft-password',
      })
    ).data;
  const f = (await call('POST', '/families', cook, { name: '草稿测试小家' })).data,
    base = '/families/' + f.id;
  let menu = (await call('GET', base + '/menu', cook)).data;
  const c1 = menu.collections[0].id;
  const dish = await call('POST', base + '/dishes', cook, {
    name: '只有菜名',
    minutes: 15,
    servings: 2,
    collectionId: c1,
  });
  assert.equal(dish.status, 200, JSON.stringify(dish.data));
  const inv = (await call('POST', base + '/invitations', cook, { role: 'eater' })).data;
  await call('POST', '/invitations/' + inv.token + '/accept', eater, {});
  assert.equal(
    (
      await call('POST', base + '/inventory', eater, {
        name: '番茄',
        quantity: 2,
        unit: '个',
        category: '蔬菜',
      })
    ).status,
    200,
  );
  assert.equal(
    (await call('GET', base + '/dishes/' + dish.data.id + '/recipe', eater)).status,
    403,
  );
  menu = (await call('GET', base + '/menu', cook)).data;
  const body = {
    version: menu.family.version,
    collections: [
      { id: c1, name: '旧合集' },
      { id: 'draft-new', name: '新合集' },
    ],
    dishes: [{ id: dish.data.id, collectionId: 'draft-new' }],
    deletedDishIds: [],
    recipes: [],
  };
  const invalid = { ...body, dishes: [{ id: dish.data.id, collectionId: 'missing' }] };
  assert.equal((await call('PUT', base + '/menu-layout', cook, invalid)).status, 400);
  assert.equal(
    (await call('GET', base + '/menu', cook)).data.collections[0].name,
    menu.collections[0].name,
    'failed save must roll back collection renames',
  );
  assert.equal((await call('PUT', base + '/menu-layout', eater, body)).status, 403);
  assert.equal((await call('PUT', base + '/menu-layout', cook, body)).status, 200);
  const saved = (await call('GET', base + '/menu', cook)).data;
  assert.equal(saved.collections.find((c) => c.id === saved.dishes[0].collectionId).name, '新合集');
  assert.equal(
    (await call('PUT', base + '/menu-layout', cook, body)).status,
    409,
    'stale save must not overwrite another edit',
  );
});
