import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';
import { today } from '../src/core/policy.mjs';

test('two accounts share a household; recipe choices and current prep stay consistent', async (t) => {
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
  async function call(method, path, user, payload) {
    const res = await app.inject({
      method,
      url: path,
      payload,
      headers: user
        ? {
            authorization: 'Bearer ' + user.token,
            'idempotency-key': randomUUID(),
          }
        : { 'idempotency-key': randomUUID() },
    });
    return { status: res.statusCode, data: res.json() };
  }
  const cook = (
    await call('POST', '/auth/register', null, { username: 'options_cook', password: 'sixpass' })
  ).data;
  const eater = (
    await call('POST', '/auth/register', null, { username: 'options_eater', password: 'sixpass' })
  ).data;
  const outsider = (
    await call('POST', '/auth/register', null, { username: 'options_other', password: 'sixpass' })
  ).data;
  assert.ok(cook.token && eater.token && outsider.token);
  const family = (await call('POST', '/families', cook, { name: '口味测试小家' })).data;
  const base = '/families/' + family.id;
  assert.equal((await call('GET', base + '/menu', outsider)).status, 404);
  const invite = (await call('POST', base + '/invitations', cook, { role: 'eater' })).data;
  assert.equal(
    (await call('POST', '/invitations/' + invite.token + '/accept', eater, {})).status,
    200,
  );
  const collection = (await call('GET', base + '/menu', cook)).data.collections[0].id;
  const filling = randomUUID(),
    soup = randomUUID();
  const pork = randomUUID(),
    shrimp = randomUUID(),
    clear = randomUUID(),
    spicy = randomUUID();
  const body = {
    name: '小馄饨',
    collectionId: collection,
    minutes: 15,
    servings: 2,
    ingredients: [
      { name: '葱', quantity: 2, unit: '根' },
      { name: '盐', quantity: 3, unit: '克' },
    ],
    steps: [
      { text: '准备馅料', important: true },
      { text: '包馄饨', important: false },
    ],
    optionGroups: [
      {
        id: filling,
        title: '馅料',
        mode: 'multiple',
        choices: [
          { id: pork, label: '鲜肉' },
          { id: shrimp, label: '虾仁' },
        ],
      },
      {
        id: soup,
        title: '汤底',
        mode: 'single',
        choices: [
          { id: clear, label: '清汤' },
          { id: spicy, label: '红汤' },
        ],
      },
    ],
  };
  const created = await call('POST', base + '/dishes', cook, body);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const dishId = created.data.id;
  const publicMenu = await call('GET', base + '/menu', eater);
  assert.equal(publicMenu.data.dishes[0].optionGroups.length, 2);
  assert.equal('ingredients' in publicMenu.data.dishes[0], false);
  assert.equal((await call('GET', base + '/dishes/' + dishId + '/recipe', eater)).status, 403);
  const recipe = await call('GET', base + '/dishes/' + dishId + '/recipe', cook);
  assert.deepEqual(
    recipe.data.steps.map((s) => s.important),
    [true, false],
  );
  const date = today();
  const order = {
    date,
    slot: '晚餐',
    items: [
      {
        dishId,
        quantity: 2,
        selectedOptions: [
          { groupId: filling, choiceIds: [pork, shrimp] },
          { groupId: soup, choiceIds: [clear] },
        ],
      },
    ],
  };
  assert.equal(
    (await call('POST', base + '/orders', eater, { ...order, items: [{ dishId, quantity: 2 }] }))
      .status,
    400,
  );
  assert.equal(
    (
      await call('POST', base + '/orders', eater, {
        ...order,
        items: [
          {
            dishId,
            quantity: 2,
            selectedOptions: [
              { groupId: filling, choiceIds: [pork] },
              { groupId: soup, choiceIds: [clear, spicy] },
            ],
          },
        ],
      })
    ).status,
    400,
  );
  const placed = await call('POST', base + '/orders', eater, order);
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(
    (
      await call('POST', base + '/orders/' + placed.data.id + '/reply', cook, {
        decision: 'accept',
        reply: '',
      })
    ).status,
    200,
  );
  const meal = (await call('GET', base + '/meals?date=' + date, eater)).data;
  assert.deepEqual(
    meal.dishes[0].snapshot.selectedOptions.map((x) => x.choices.map((c) => c.label)),
    [['鲜肉', '虾仁'], ['清汤']],
  );
  const prepBefore = (await call('GET', base + '/prep?date=' + date, cook)).data;
  assert.deepEqual(
    prepBefore.map((x) => [x.name, x.quantity]),
    [
      ['葱', 4],
      ['盐', 6],
    ],
  );
  const changed = await call('PUT', base + '/dishes/' + dishId, cook, {
    ...body,
    version: recipe.data.version,
    ingredients: [
      { name: '鸡蛋', quantity: 1, unit: '个' },
      { name: '盐', quantity: 1, unit: '克' },
    ],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const prepAfter = (await call('GET', base + '/prep?date=' + date, cook)).data;
  assert.deepEqual(
    prepAfter.map((x) => [x.name, x.quantity]),
    [
      ['鸡蛋', 2],
      ['盐', 2],
    ],
  );
  const share = (await call('POST', base + '/shares', cook, { dishIds: [dishId] })).data;
  const packet = (await call('GET', '/shares/' + share.token, eater)).data;
  assert.equal(packet.dishes[0].optionGroups.length, 2);
});
