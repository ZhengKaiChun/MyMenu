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
  await t.test('notification preference persists per account without erasing notices', async () => {
    const before = (await call('GET', '/notifications', cook)).length;
    assert.equal((await call('GET', '/notifications/preferences', cook)).enabled, true);
    await call('PATCH', '/notifications/preferences', cook, { enabled: false });
    assert.equal((await call('GET', '/notifications/preferences', cook)).enabled, false);
    assert.equal((await call('GET', '/notifications/preferences', eater)).enabled, true);
    assert.equal((await call('GET', '/notifications', cook)).length, before);
    await call('PATCH', '/notifications/preferences', cook, { enabled: true });
  });
  await t.test('diary excludes today and purges expired device-local history', async () => {
    const dates = require('../../miniprogram/lib/dates.js'),
      key = 'geiwofan.preview.database.v1';
    const original = JSON.parse(JSON.stringify(storage.get(key))),
      fixture = JSON.parse(JSON.stringify(original));
    const source = fixture.orders.find(
      (o) => o.family_id === 'preview-home' && o.status === 'accepted',
    );
    const clone = (id, date) => ({
      ...JSON.parse(JSON.stringify(source)),
      id,
      meal_date: date,
      items: source.items.map((l, i) => ({ ...l, id: id + '-' + i, done: true })),
    });
    const yesterday = dates.shift(today(), -1),
      expired = dates.shift(dates.bounds().min, -1);
    fixture.orders.push(clone('history-yesterday', yesterday), clone('history-expired', expired));
    fixture.checks['preview-home' + expired] = [];
    storage.set(key, fixture);
    assert.equal((await call('GET', base + '/history?date=' + today(), cook)).dishes.length, 0);
    assert.ok((await call('GET', base + '/history?date=' + yesterday, cook)).dishes.length > 0);
    const saved = storage.get(key);
    assert.equal(
      saved.orders.some((o) => o.id === 'history-expired'),
      false,
    );
    assert.equal(saved.checks['preview-home' + expired], undefined);
    storage.set(key, original);
  });
  await t.test(
    'multi-collection preview persists memberships and copies one independent dish',
    async () => {
      const f = await call('POST', '/families', cook, { name: '本机多合集' }),
        path = '/families/' + f.id;
      let menu = await call('GET', path + '/menu', cook);
      const a = menu.collections[0].id;
      const b = (await call('POST', path + '/collections', cook, { name: '暖汤' })).id;
      const body = {
        name: '番茄汤',
        minutes: 10,
        servings: 2,
        collectionId: a,
        collectionIds: [a, b],
        ingredients: [],
        steps: [],
      };
      const d = await call('POST', path + '/dishes', cook, body);
      menu = await call('GET', path + '/menu', cook);
      assert.equal(menu.dishes.length, 1);
      assert.equal(menu.dishes[0].collectionIds.length, 2);
      await assert.rejects(
        call('POST', path + '/dishes', cook, { ...body, collectionIds: [a, a] }),
      );
      await assert.rejects(
        call('POST', path + '/dishes', cook, { ...body, collectionIds: [a, 'preview-foreign'] }),
      );
      const share = await call('POST', path + '/shares', cook, { dishIds: [d.id] });
      const imported = await call('POST', '/imports', cook, {
        token: share.token,
        newFamilyName: '本机复制',
        mode: 'add',
        scope: 'matching',
      });
      const copy = await call('GET', '/families/' + imported.familyId + '/menu', cook);
      assert.equal(copy.dishes.length, 1);
      assert.equal(copy.dishes[0].collectionIds.length, 2);
      assert.ok(copy.dishes[0].collectionIds.every((id) => ![a, b].includes(id)));
      const draft = {
        version: menu.family.version,
        collections: menu.collections.map((c) => ({ id: c.id, name: c.name })),
        dishes: [{ id: d.id, collectionId: b, collectionIds: [b] }],
        recipes: [],
        deletedDishIds: [],
      };
      await call('PUT', path + '/menu-layout', cook, draft);
      assert.deepEqual((await call('GET', path + '/menu', cook)).dishes[0].collectionIds, [b]);
    },
  );
  await t.test(
    'built-in avatar saves and survives a new session without moving packaged files',
    async () => {
      const preset = await preview.upload('/assets/avatars/pig-2.png');
      await call('PATCH', '/me', cook, { nickname: '小猪头像', avatarId: preset.id });
      const refreshed = await call('GET', '/me', cook);
      assert.equal(refreshed.avatarId, preset.id);
      assert.equal(preview.image(refreshed.avatarId, ''), '/assets/avatars/pig-2.png');
    },
  );
  await t.test('achievement counts survive pruning and disappear with their home', async () => {
    const u = await call('POST', '/auth/register', null, {
      username: 'personal_preview',
      password: 'personal-preview-password',
    });
    const f = await call('POST', '/families', u, { name: '成就测试' }),
      path = '/families/' + f.id,
      m = await call('GET', path + '/menu', u);
    const d = await call('POST', path + '/dishes', u, {
      name: '煎蛋',
      collectionId: m.collections[0].id,
      minutes: 5,
      servings: 2,
      ingredients: [],
      steps: [],
    });
    await call('POST', path + '/orders', u, {
      date: today(),
      slot: '晚餐',
      items: [{ dishId: d.id, quantity: 3 }],
    });
    const b = { date: today(), slot: '晚餐', dishIds: [d.id] };
    await call('PUT', path + '/cooking-records', u, b);
    await call('PUT', path + '/cooking-records', u, b);
    assert.equal((await call('GET', '/me/achievements', u)).cooked, 1);
    const key = 'geiwofan.preview.database.v1',
      db = storage.get(key),
      dates = require('../../miniprogram/lib/dates.js'),
      expired = dates.shift(dates.bounds().min, -1);
    db.orders.filter((o) => o.family_id === f.id).forEach((o) => (o.meal_date = expired));
    db.cookingRecords.filter((c) => c.familyId === f.id).forEach((c) => (c.date = expired));
    storage.set(key, db);
    for (let i = 0; i < 2; i++) {
      const stats = await call('GET', '/me/achievements', u);
      assert.equal(stats.cooked, 1);
      assert.equal(stats.ordered, 3);
    }
    await call('POST', path + '/dissolution', u, {});
    assert.equal((await call('GET', '/me/achievements', u)).ordered, 0);
    assert.equal((await call('GET', '/me/achievements', u)).cooked, 0);
    const changed = await call(
      'POST',
      '/me/credentials',
      u,
      {
        username: 'changed_preview',
        currentPassword: 'personal-preview-password',
        newPassword: 'changed-preview-password',
      },
      'credential-secret-retry',
    );
    await assert.rejects(call('GET', '/me', u));
    assert.equal((await call('GET', '/me/security', changed)).username, 'changed_preview');
    assert.equal(JSON.stringify(storage.get(key)).includes('changed-preview-password'), false);
  });
  await t.test('formal releases reject the device-local transport', async () => {
    env = 'release';
    await assert.rejects(call('GET', '/capabilities'), (e) => e.code === 'PREVIEW_NOT_PRODUCTION');
    assert.equal(network, 0);
  });
});
