import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const preview = require('../../miniprogram/preview/index.js');
const fingerprint = require('../../miniprogram/preview/hash.js');
const { today } = require('../../miniprogram/preview/seed.js');
test('standalone import preview runs without HTTP and preserves separate device-local business data', async (t) => {
  const storage = new Map();
  let network = 0,
    env = 'develop';
  globalThis.wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: (k) => storage.delete(k),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }),
    request() {
      network++;
      throw Error('Preview must not access HTTP');
    },
  };
  t.after(() => {
    delete globalThis.wx;
  });
  const call = async (method, path, user, body = {}, key) =>
    preview.request(path, { method, body, ...(key ? { key } : {}) }, user?.token);
  const cook = await call('POST', '/auth/preview', null, { role: 'cook' }),
    eater = await call('POST', '/auth/preview', null, { role: 'eater' }),
    base = '/families/preview-home';
  await t.test('password fingerprints match standard SHA256 vectors', () => {
    assert.equal(
      fingerprint('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      fingerprint(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  await t.test('client request and native assets never request the inactive backend', async () => {
    const session = require('../../miniprogram/lib/session.js'),
      api = require('../../miniprogram/lib/api.js');
    session.saveAuth(cook);
    assert.equal((await api.request('/capabilities')).preview, true);
    assert.equal((await api.request(base + '/menu')).dishes.length, 4);
    assert.equal(await api.image('preview-food-0'), '/assets/food-0.jpg');
    assert.equal(network, 0);
    assert.ok(storage.has('menu.preview.session'));
    assert.equal(storage.has('menu.session'), false);
  });
  await t.test('roles and recipe DTOs remain isolated in preview', async () => {
    const menu = await call('GET', base + '/menu', eater);
    assert.equal(menu.family.role, 'eater');
    assert.ok(menu.dishes.every((d) => !d.ingredients && !d.steps));
    await assert.rejects(
      call('GET', base + '/dishes/preview-dish-0/recipe', eater),
      (e) => e.status === 403,
    );
    assert.ok((await call('GET', base + '/dishes/preview-dish-0/recipe', cook)).steps.length);
  });
  await t.test(
    'new preview registration stays wild and creates an empty home without onboarding',
    async () => {
      const u = await call('POST', '/auth/register', null, {
        username: 'preview_new',
        password: 'local-test-password',
      });
      assert.equal(u.user.nickname, '野生小猪');
      assert.equal((await call('GET', '/families', u)).length, 0);
      const f = await call('POST', '/families', u, { name: '新小家' });
      const m = await call('GET', '/families/' + f.id + '/menu', u);
      assert.equal(m.family.identity, '野生小猪');
      assert.equal(m.dishes.length, 0);
      assert.equal((await call('GET', '/families/' + f.id + '/inventory', u)).length, 0);
      const persisted = JSON.stringify(storage.get('geiwofan.preview.database.v1'));
      assert.equal(persisted.includes('local-test-password'), false);
      assert.ok(
        (
          await call('POST', '/auth/password', null, {
            username: 'preview_new',
            password: 'local-test-password',
          })
        ).token,
      );
    },
  );
  let order;
  await t.test(
    'orders, replies and compact ingredient sources work with the backend stopped',
    async () => {
      order = await call(
        'POST',
        base + '/orders',
        eater,
        {
          date: today(),
          slot: '晚餐',
          note: '今晚一起吃',
          items: [
            { dishId: 'preview-dish-0', quantity: 1 },
            { dishId: 'preview-dish-2', quantity: 1 },
          ],
        },
        'offline-order',
      );
      assert.equal(order.status, 'pending');
      await call('POST', base + '/orders/' + order.id + '/reply', cook, {
        decision: 'accept',
        reply: '好呀',
      });
      const meal = await call('GET', base + '/meals?date=' + today(), eater);
      assert.equal(meal.dishes.find((d) => d.dishId === 'preview-dish-0').sources.length, 2);
      const prep = await call('GET', base + '/prep?date=' + today(), cook);
      assert.ok(prep.find((i) => i.name === '盐').sources.length >= 2);
      assert.equal(prep.find((i) => i.name === '番茄').checked, true);
    },
  );
  await t.test('replacement changes only the requesting member line', async () => {
    const lines = await call('GET', base + '/my-lines', eater),
      line = lines.find((l) => l.dish_id === 'preview-dish-0' && l.status === 'accepted');
    const c = await call('POST', base + '/changes', eater, {
      lineId: line.id,
      replacementId: 'preview-dish-1',
      reason: '想换个口味',
    });
    const change = (await call('GET', base + '/changes', eater)).find((x) => x.id === c.id);
    assert.equal(change.meal_date, today());
    assert.equal(change.slot, line.slot);
    assert.equal(change.quantity, line.quantity);
    assert.equal(change.new_snapshot.ingredients, undefined);
    assert.equal(change.new_snapshot.steps, undefined);
    await call('POST', base + '/changes/' + c.id + '/reply', cook, {
      decision: 'accept',
      reply: '安排',
    });
    const meal = await call('GET', base + '/meals?date=' + today(), eater);
    assert.ok(
      meal.dishes.some(
        (d) => d.dishId === 'preview-dish-0' && d.sources.some((s) => s.userId === cook.user.id),
      ),
    );
    assert.ok(
      meal.dishes.some(
        (d) => d.dishId === 'preview-dish-1' && d.sources.some((s) => s.userId === eater.user.id),
      ),
    );
  });
  await t.test('recipe copy is independent and supports idempotent import', async () => {
    const s = await call('POST', base + '/shares', cook, { dishIds: ['preview-dish-0'] });
    const b = { token: s.token, newFamilyName: '收到好味道', mode: 'add', scope: 'matching' },
      check = await call('POST', '/imports/preview', eater, b);
    const copied = await call(
        'POST',
        '/imports',
        eater,
        { ...b, version: check.version },
        'offline-copy',
      ),
      again = await call(
        'POST',
        '/imports',
        eater,
        { ...b, version: check.version },
        'offline-copy',
      );
    assert.equal(copied.familyId, again.familyId);
    const m = await call('GET', '/families/' + copied.familyId + '/menu', eater);
    assert.equal(m.dishes.length, 1);
    const d = await call(
      'GET',
      '/families/' + copied.familyId + '/dishes/' + m.dishes[0].id + '/recipe',
      eater,
    );
    await call('PUT', '/families/' + copied.familyId + '/dishes/' + d.id, eater, {
      ...d,
      name: '我的独立菜',
    });
    assert.equal((await call('GET', base + '/menu', cook)).dishes[0].name, '番茄炒蛋');
  });
  await t.test('dissolution requires both members, preserves home on rejection', async () => {
    const p = await call('POST', base + '/dissolution', cook);
    assert.equal(p.status, 'pending');
    assert.equal(
      (await call('GET', '/families', cook)).some((f) => f.id === 'preview-home'),
      true,
    );
    await call('POST', base + '/dissolution/' + p.id + '/vote', eater, { decision: 'reject' });
    assert.equal(
      (await call('GET', '/families', cook)).some((f) => f.id === 'preview-home'),
      true,
    );
  });
  await t.test('formal releases reject the device-local transport', async () => {
    env = 'release';
    await assert.rejects(call('GET', '/capabilities'), (e) => e.code === 'PREVIEW_NOT_PRODUCTION');
    assert.equal(network, 0);
  });
});
