import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.mjs';

test('one dish belongs to multiple family-owned collections through drafts, sharing and rollback', async (t) => {
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
  async function call(method, url, u, payload) {
    const r = await app.inject({
      method,
      url,
      payload,
      headers: u ? { authorization: 'Bearer ' + u.token, 'idempotency-key': randomUUID() } : {},
    });
    return { ...r.json(), status: r.statusCode };
  }
  const cook = await call('POST', '/auth/register', null, {
    username: 'multi_cook',
    password: 'multi-collection-password',
  });
  const outsider = await call('POST', '/auth/register', null, {
    username: 'multi_other',
    password: 'multi-collection-password',
  });
  const f = await call('POST', '/families', cook, { name: '多合集小家' }),
    base = '/families/' + f.id;
  const original = await call('GET', base + '/menu', cook),
    a = original.collections[0].id;
  const b = (await call('POST', base + '/collections', cook, { name: '晚餐推荐' })).id;
  const foreign = await call('POST', '/families', outsider, { name: '另一个小家' });
  const foreignId = (await call('GET', '/families/' + foreign.id + '/menu', outsider))
    .collections[0].id;
  const body = {
    name: '一碗番茄蛋',
    minutes: 10,
    servings: 2,
    collectionId: a,
    collectionIds: [a, b],
  };
  assert.equal(
    (await call('POST', base + '/dishes', cook, { ...body, collectionIds: [a, foreignId] })).status,
    400,
  );
  assert.equal(
    (await call('POST', base + '/dishes', cook, { ...body, collectionIds: [] })).status,
    400,
  );
  assert.equal(
    (await call('POST', base + '/dishes', cook, { ...body, collectionIds: [a, a] })).status,
    400,
  );
  const created = await call('POST', base + '/dishes', cook, body);
  assert.equal(created.status, 200, JSON.stringify(created));
  let menu = await call('GET', base + '/menu', cook);
  assert.equal(menu.dishes.length, 1);
  assert.deepEqual(new Set(menu.dishes[0].collectionIds), new Set([a, b]));
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM dish_collections WHERE dish_id=$1', [
        created.id,
      ])
    ).rows[0].n,
    2,
  );
  const read = await call('GET', base + '/dishes/' + created.id + '/recipe', cook);
  assert.deepEqual(new Set(read.collectionIds), new Set([a, b]));
  const share = await call('POST', base + '/shares', cook, { dishIds: [created.id] });
  const packet = await call('GET', '/shares/' + share.token, cook);
  assert.equal(packet.dishes.length, 1);
  assert.equal(packet.dishes[0].categories.length, 2);
  const imported = await call('POST', '/imports', cook, {
    token: share.token,
    newFamilyName: '复制的小家',
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
    dishes: [{ id: created.id, collectionId: a, collectionIds: [a, foreignId] }],
    recipes: [],
    deletedDishIds: [],
  };
  assert.equal((await call('PUT', base + '/menu-layout', cook, draft)).status, 400);
  menu = await call('GET', base + '/menu', cook);
  assert.equal(
    menu.family.version,
    draft.version,
    'invalid memberships roll back the entire draft',
  );
  assert.equal(menu.collections.find((c) => c.id === a).name, original.collections[0].name);
  assert.equal(menu.dishes[0].collectionIds.length, 2);
  draft.collections.push({ id: 'draft-soup', name: '暖汤' });
  draft.dishes[0] = { id: created.id, collectionId: b, collectionIds: [b, 'draft-soup'] };
  const saved = await call('PUT', base + '/menu-layout', cook, draft);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  menu = await call('GET', base + '/menu', cook);
  assert.deepEqual(
    new Set(menu.dishes[0].collectionIds),
    new Set([b, saved.collectionMap['draft-soup']]),
  );
  assert.equal((await call('DELETE', base + '/collections/' + b, cook)).status, 409);
  const latest = await call('GET', base + '/dishes/' + created.id + '/recipe', cook);
  assert.equal(
    (
      await call('PUT', base + '/dishes/' + created.id, cook, {
        ...body,
        collectionId: b,
        collectionIds: [b],
        version: latest.version,
      })
    ).status,
    200,
  );
  menu = await call('GET', base + '/menu', cook);
  assert.deepEqual(menu.dishes[0].collectionIds, [b]);
  // Database also forbids a relation spanning two families, even outside the API.
  await assert.rejects(
    db.query('INSERT INTO dish_collections(dish_id,collection_id,family_id) VALUES($1,$2,$3)', [
      created.id,
      foreignId,
      f.id,
    ]),
  );
});
