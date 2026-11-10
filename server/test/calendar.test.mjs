import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.mjs';
import { today } from '../src/core/policy.mjs';
import { randomUUID } from 'node:crypto';
test('calendar dates use authorized family records and distinguish cooked history', async (t) => {
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
  async function call(method, url, token, body) {
    const r = await app.inject({
      method,
      url,
      headers: token ? { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() } : {},
      payload: body,
    });
    return { status: r.statusCode, data: r.json() };
  }
  const a = (
    await call('POST', '/auth/register', null, {
      username: 'calendar_cook',
      password: 'calendar-test-password',
    })
  ).data;
  const b = (
    await call('POST', '/auth/register', null, {
      username: 'calendar_other',
      password: 'calendar-test-password',
    })
  ).data;
  const home = (await call('POST', '/families', a.token, { name: '日历小家' })).data,
    base = '/families/' + home.id;
  const menu = (await call('GET', base + '/menu', a.token)).data;
  const dish = (
    await call('POST', base + '/dishes', a.token, {
      name: '日历番茄',
      intro: '',
      collectionId: menu.collections[0].id,
      minutes: 10,
      servings: 2,
      ingredients: [{ name: '番茄', quantity: 1, unit: '个' }],
      steps: [{ text: '洗净切块炒熟。' }],
    })
  ).data;
  const date = today();
  await call('POST', base + '/orders', a.token, {
    date,
    slot: '晚餐',
    note: '',
    items: [{ dishId: dish.id, quantity: 1 }],
  });
  await t.test('member dates are returned as exact YYYY-MM-DD strings', async () => {
    const r = await call('GET', base + '/meal-dates?from=' + date + '&to=' + date, a.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, [{ date }]);
  });
  await t.test('calendar is protected against outsiders and unbounded ranges', async () => {
    assert.equal(
      (await call('GET', base + '/meal-dates?from=' + date + '&to=' + date, b.token)).status,
      404,
    );
    assert.equal(
      (await call('GET', base + '/meal-dates?from=2026-01-01&to=2026-12-31', a.token)).status,
      400,
    );
  });
  await t.test('history marks only dates with completed meals', async () => {
    const path = base + '/meal-dates?from=' + date + '&to=' + date + '&done=1';
    assert.deepEqual((await call('GET', path, a.token)).data, []);
    const meal = (await call('GET', base + '/meals?date=' + date, a.token)).data;
    await call('POST', base + '/lines/' + meal.dishes[0].sources[0].id + '/done', a.token, {});
    assert.deepEqual((await call('GET', path, a.token)).data, [{ date }]);
  });
});
