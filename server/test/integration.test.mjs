import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';
import { configFromEnv } from '../src/config.mjs';
import { today } from '../src/core/policy.mjs';
test('real PostgreSQL domain and access-control integration', async (t) => {
  const { app, db } = await buildApp({
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'test-key-long-enough-to-be-private',
      pepper: 'test-pepper',
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
    logger: false,
  });
  t.after(() => app.close());
  async function call(method, url, user, payload, key) {
    const r = await app.inject({
      method,
      url,
      headers: {
        ...(user ? { authorization: 'Bearer ' + user.token } : {}),
        ...(method !== 'GET' ? { 'idempotency-key': key || randomUUID() } : {}),
      },
      payload,
    });
    return { status: r.statusCode, data: r.json() };
  }
  async function expect(method, url, user, payload, status = 200, key) {
    const r = await call(method, url, user, payload, key);
    assert.equal(r.status, status, JSON.stringify(r.data));
    return r.data;
  }
  const password = 'local-test-password-2026';
  const a = await expect('POST', '/auth/register', null, { username: 'cook_a', password });
  const b = await expect('POST', '/auth/register', null, { username: 'eater_b', password });
  const c = await expect('POST', '/auth/register', null, { username: 'outside_c', password });
  let home = await expect('POST', '/families', a, { name: '安全测试小家' });
  const base = '/families/' + home.id;
  let menu = await expect('GET', base + '/menu', a);
  let collection = menu.collections[0].id;
  const recipe = (name, ingredients) => ({
    name,
    intro: '一起好好吃饭',
    collectionId: collection,
    minutes: 15,
    servings: 2,
    ingredients,
    steps: [{ text: '食材洗净，按步骤制作。' }],
  });
  let d1 = await expect(
    'POST',
    base + '/dishes',
    a,
    recipe('番茄炒蛋', [
      { name: '番茄', quantity: 2, unit: '个' },
      { name: '鸡蛋', quantity: 3, unit: '个' },
    ]),
  );
  let d2 = await expect(
    'POST',
    base + '/dishes',
    a,
    recipe('蜜汁鸡翅', [
      { name: '鸡翅', quantity: 8, unit: '只' },
      { name: '蜂蜜', quantity: 15, unit: 'g' },
    ]),
  );
  await t.test('anonymous requests rejected', async () => {
    await expect('GET', '/families', null, undefined, 401);
  });
  await t.test('outsider cannot enumerate family data', async () => {
    await expect('GET', base + '/menu', c, undefined, 404);
  });
  let invite = await expect('POST', base + '/invitations', a, { role: 'eater' });
  await expect('POST', '/invitations/' + invite.token + '/accept', b, {});
  await t.test('menu DTO never discloses recipe details', async () => {
    let out = await expect('GET', base + '/menu', b);
    assert.equal(out.family.role, 'eater');
    assert.ok(out.dishes.every((d) => !('ingredients' in d) && !('steps' in d)));
    await expect('GET', base + '/dishes/' + d1.id + '/recipe', b, undefined, 403);
    await expect(
      'POST',
      base + '/dishes',
      b,
      recipe('越权', [{ name: '盐', quantity: 1, unit: 'g' }]),
      403,
    );
  });
  await t.test('privilege escalation and cross-family collection rejected', async () => {
    await expect('POST', base + '/members/' + b.user.id + '/role', b, { role: 'cook' }, 403);
    await expect(
      'POST',
      base + '/orders',
      b,
      { date: today(), slot: '晚餐', items: [{ dishId: d1.id, quantity: 1 }], role: 'cook' },
      400,
    );
  });
  const key = randomUUID(),
    body = { date: today(), slot: '晚餐', note: '少盐', items: [{ dishId: d1.id, quantity: 1 }] };
  let own = await expect('POST', base + '/orders', a, body);
  let order = await expect('POST', base + '/orders', b, body, 200, key);
  await t.test('order idempotency and requester privacy', async () => {
    let again = await expect('POST', base + '/orders', b, body, 200, key);
    assert.equal(order.id, again.id);
    let mine = await expect('GET', base + '/orders', b);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, order.id);
    assert.equal(order.status, 'pending');
    assert.equal(own.status, 'accepted');
  });
  await expect('POST', base + '/orders/' + order.id + '/reply', a, {
    decision: 'accept',
    reply: '好呀',
  });
  await t.test('multiple members aggregate without losing sources', async () => {
    let meal = await expect('GET', base + '/meals?date=' + today(), b);
    assert.equal(meal.dishes[0].quantity, 2);
    assert.equal(meal.dishes[0].sources.length, 2);
  });
  let lines = await expect('GET', base + '/my-lines', b);
  let change = await expect('POST', base + '/changes', b, {
    lineId: lines[0].id,
    replacementId: d2.id,
    reason: '想换一道',
  });
  await t.test('pending replacement keeps original and cannot be self-approved', async () => {
    await expect('POST', base + '/changes/' + change.id + '/reply', b, { decision: 'accept' }, 403);
    let meal = await expect('GET', base + '/meals?date=' + today(), a);
    assert.equal(meal.dishes[0].quantity, 2);
  });
  await expect('POST', base + '/changes/' + change.id + '/reply', a, {
    decision: 'accept',
    reply: '换鸡翅',
  });
  await t.test('replacement changes requester source only and prep recomputes', async () => {
    let meal = await expect('GET', base + '/meals?date=' + today(), a);
    assert.equal(meal.dishes.length, 2);
    assert.equal(meal.dishes.find((d) => d.dishId === d1.id).quantity, 1);
    let prep = await expect('GET', base + '/prep?date=' + today(), a);
    assert.equal(Number(prep.find((i) => i.name === '鸡翅').quantity), 8);
    assert.equal(Number(prep.find((i) => i.name === '番茄').quantity), 2);
    await expect('GET', base + '/prep?date=' + today(), b, undefined, 403);
  });
  await t.test('stale edits are rejected', async () => {
    let original = await expect('GET', base + '/dishes/' + d1.id + '/recipe', a);
    await expect('PUT', base + '/dishes/' + d1.id, a, {
      ...recipe('番茄炒蛋', [{ name: '番茄', quantity: 2, unit: '个' }]),
      version: original.version,
    });
    await expect(
      'PUT',
      base + '/dishes/' + d1.id,
      a,
      { ...recipe('误覆盖', [{ name: '盐', quantity: 1, unit: 'g' }]), version: original.version },
      409,
    );
  });
  let share = await expect('POST', base + '/shares', a, { dishIds: [d1.id] });
  let gift = await expect('GET', '/shares/' + share.token, b);
  await t.test('explicit share reveals selected recipes only', async () => {
    assert.equal(gift.dishes.length, 1);
    assert.ok(gift.dishes[0].ingredients.length);
    await expect('POST', base + '/shares', b, { dishIds: [d1.id] }, 403);
  });
  let imported = await expect('POST', '/imports', b, {
    token: share.token,
    newFamilyName: '接收方独立小家',
    mode: 'add',
    scope: 'matching',
  });
  let other = '/families/' + imported.familyId;
  await t.test('copy creates a real independent family atomically', async () => {
    let out = await expect('GET', other + '/menu', b);
    assert.equal(out.dishes.length, 1);
    assert.notEqual(out.dishes[0].id, d1.id);
    assert.equal(out.family.role, 'cook');
    let source = await expect('GET', base + '/menu', a);
    assert.equal(source.dishes.length, 2);
  });
  await t.test('read-only target cannot be imported into', async () => {
    await expect(
      'POST',
      '/imports/preview',
      b,
      { token: share.token, familyId: home.id, mode: 'overwrite', scope: 'whole' },
      403,
    );
  });
  const preview = await expect('POST', '/imports/preview', a, {
    token: share.token,
    familyId: home.id,
    mode: 'overwrite',
    scope: 'whole',
  });
  await expect('POST', '/imports', a, {
    token: share.token,
    familyId: home.id,
    mode: 'overwrite',
    scope: 'whole',
    version: preview.version,
  });
  await t.test(
    'whole overwrite soft archives menu while preserving ordered snapshots',
    async () => {
      let out = await expect('GET', base + '/menu', a);
      assert.equal(out.dishes.length, 1);
      let meal = await expect('GET', base + '/meals?date=' + today(), a);
      assert.equal(meal.dishes.length, 2);
    },
  );
  await t.test('SQL-shaped input remains data and never bypasses membership', async () => {
    await expect('POST', '/families', a, { name: "x'; DROP TABLE users; --" });
    await expect('GET', base + '/menu', c, undefined, 404);
    assert.ok((await expect('GET', '/me', a)).id);
  });
  let invitation = await expect('POST', base + '/invitations', a, { role: 'eater' });
  await expect('POST', '/invitations/' + invitation.token + '/accept', c, {});
  let d = await expect('POST', base + '/dissolution', a, {});
  await expect('POST', base + '/dissolution/' + d.id + '/vote', b, { decision: 'agree' });
  await t.test('all members must consent, not just two', async () => {
    await expect('GET', base + '/menu', a);
    let out = await expect('GET', base + '/dissolution', a);
    assert.equal(out.status, 'pending');
    assert.equal(out.votes.length, 3);
  });
  await expect('POST', base + '/dissolution/' + d.id + '/vote', c, { decision: 'reject' });
  await t.test('one rejection preserves family', async () => {
    assert.equal((await expect('GET', base + '/dissolution', a)).status, 'rejected');
    await expect('GET', base + '/menu', b);
  });
  d = await expect('POST', base + '/dissolution', a, {});
  await expect('POST', base + '/dissolution/' + d.id + '/vote', b, { decision: 'agree' });
  await expect('POST', base + '/dissolution/' + d.id + '/vote', c, { decision: 'agree' });
  await t.test('unanimous dissolution revokes access and invitations', async () => {
    await expect('GET', base + '/menu', a, undefined, 404);
    await expect('GET', '/shares/' + share.token, b, undefined, 410);
    await expect('GET', other + '/menu', b);
  });
  await t.test('no credentials stored or exposed as plaintext', async () => {
    const row = (await db.query('SELECT password_hash FROM users WHERE id=$1', [a.user.id]))
      .rows[0];
    assert.ok(row.password_hash.startsWith('scrypt$'));
    assert.notEqual(row.password_hash, password);
    assert.ok(!JSON.stringify(await expect('GET', '/me', a)).includes('password'));
    await expect('POST', '/auth/logout', a, {});
    await expect('GET', '/me', a, undefined, 401);
  });
});
test('production configuration rejects unsafe defaults', () => {
  assert.throws(() => configFromEnv({ NODE_ENV: 'production' }));
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true' }));
});
