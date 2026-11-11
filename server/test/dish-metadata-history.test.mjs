import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDatabase } from '../src/core/db.mjs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.mjs';
import { recipe } from '../src/core/validation.mjs';
import { pruneHistory } from '../src/jobs/retention.mjs';
const dates = createRequire(import.meta.url)('../../miniprogram/lib/dates.js');
test('dish badges, meat taxonomy, shares and past-only history persist with permissions', async (t) => {
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
      headers: u ? { authorization: 'Bearer ' + u.token, 'idempotency-key': randomUUID() } : {},
      payload,
    });
    return { ...r.json(), status: r.statusCode };
  }
  const cook = await call('POST', '/auth/register', null, {
      username: 'metadata_cook',
      password: 'metadata-test-password',
    }),
    eater = await call('POST', '/auth/register', null, {
      username: 'metadata_eater',
      password: 'metadata-test-password',
    });
  const f = await call('POST', '/families', cook, { name: '暖暖的饭桌' }),
    base = '/families/' + f.id;
  const menu = await call('GET', base + '/menu', cook),
    normal = menu.collections[0].id;
  const c = await call('POST', base + '/collections', cook, { name: '肉类' });
  const body = {
    name: '微辣鸡翅',
    minutes: 20,
    servings: 2,
    collectionId: c.id,
    featured: true,
    spiceLevel: 2,
  };
  assert.equal((await call('POST', base + '/dishes', cook, body)).status, 400);
  const dish = await call('POST', base + '/dishes', cook, { ...body, meatType: '鸡' });
  assert.equal(dish.status, 200, JSON.stringify(dish));
  const plain = await call('POST', base + '/dishes', cook, {
    name: '家常汤',
    minutes: 10,
    servings: 2,
    collectionId: normal,
  });
  assert.equal(plain.status, 200);
  let read = await call('GET', base + '/menu', cook);
  assert.equal(read.dishes.find((d) => d.id === dish.id).spiceLevel, 2);
  assert.equal(read.dishes.find((d) => d.id === plain.id).spiceLevel, 1);
  assert.equal(
    (await call('POST', base + '/dishes', cook, { ...body, meatType: '鸡', spiceLevel: 4 })).status,
    400,
  );
  const invite = await call('POST', base + '/invitations', cook, { role: 'eater' });
  await call('POST', '/invitations/' + invite.token + '/accept', eater, {});
  assert.equal(
    (await call('PATCH', base + '/identity', eater, { identity: '猪大儿' })).status,
    200,
  );
  read = await call('GET', base + '/menu', eater);
  const visible = read.dishes.find((d) => d.id === dish.id);
  assert.equal(visible.featured, true);
  assert.equal(visible.meatType, '鸡');
  assert.equal(visible.ingredients, undefined);
  assert.equal((await call('GET', base + '/dishes/' + dish.id + '/recipe', eater)).status, 403);
  assert.equal(
    (
      await call('POST', base + '/inventory', eater, {
        name: '猪肉',
        quantity: 1,
        unit: '斤',
        category: '肉类',
      })
    ).status,
    400,
  );
  const inv = await call('POST', '/inventory', cook, {
    name: '鸡胸肉',
    quantity: 2,
    unit: '块',
    category: '肉类',
    meatType: '鸡',
  });
  assert.equal(inv.status, 200);
  await call('POST', base + '/inventory/import', cook, { ids: [inv.id] });
  const stock = await app.inject({
    url: base + '/inventory',
    headers: { authorization: 'Bearer ' + eater.token },
  });
  assert.equal(stock.json()[0].meatType, '鸡');
  const share = await call('POST', base + '/shares', cook, { dishIds: [dish.id] });
  const imp = { token: share.token, newFamilyName: '复制的小家', mode: 'add', scope: 'matching' };
  const check = await call('POST', '/imports/preview', eater, imp);
  const receipt = await call('POST', '/imports', eater, { ...imp, version: check.version });
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  const copied = await call('GET', '/families/' + receipt.familyId + '/menu', eater);
  assert.equal(copied.dishes[0].featured, true);
  assert.equal(copied.dishes[0].spiceLevel, 2);
  assert.equal(copied.dishes[0].meatType, '鸡');
  const today = dates.today(),
    yesterday = dates.shift(today, -1),
    old = dates.shift(dates.bounds().min, -1);
  const order = await call('POST', base + '/orders', cook, {
    date: today,
    slot: '午餐',
    items: [{ dishId: dish.id, quantity: 3 }],
  });
  assert.equal(order.status, 200);
  let history = await call('GET', base + '/history?date=' + today, eater);
  assert.equal(history.dishes.length, 0, 'today must remain a plan, even if marked done');
  await db.query('UPDATE orders SET meal_date=$2 WHERE id=$1', [order.id, yesterday]);
  history = await call('GET', base + '/history?date=' + yesterday, eater);
  assert.equal(history.dishes[0].quantity, 3);
  assert.equal(history.dishes[0].snapshot.steps, undefined);
  const idx = await app.inject({
    url: base + '/meal-dates?from=' + yesterday + '&to=' + today + '&history=1',
    headers: { authorization: 'Bearer ' + eater.token },
  });
  assert.deepEqual(idx.json(), [{ date: yesterday }]);
  await db.query('UPDATE orders SET meal_date=$2 WHERE id=$1', [order.id, old]);
  assert.equal((await call('GET', base + '/history?date=' + old, eater)).dishes.length, 0);
  await pruneHistory(db);
  assert.equal((await db.query('SELECT id FROM orders WHERE id=$1', [order.id])).rows.length, 0);
});
test('calendar month bounds handle leap years and month-end without overflow', () => {
  assert.equal(dates.month('2026-05-31', -3), '2026-02-28');
  assert.equal(dates.month('2024-05-31', -3), '2024-02-29');
  assert.deepEqual(dates.bounds('2026-03-01'), { min: '2025-12-01', max: '2026-02-28' });
});

test('display quantities combine repeated orders for the same person only', () => {
  const aggregate = createRequire(import.meta.url)('../../miniprogram/lib/orderers.js');
  const result = aggregate([
    { id: 'a', userId: 'u1', identity: '野生小猪', quantity: 1 },
    { id: 'b', userId: 'u1', identity: '野生小猪', quantity: 2 },
    { id: 'c', userId: 'u2', identity: '野生小猪', quantity: 1 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].quantity, 3);
  assert.equal(result[1].quantity, 1);
});

test('image-only instructions save while genuinely empty steps are rejected', () => {
  const body = {
    name: '图解做法',
    collectionId: randomUUID(),
    minutes: 10,
    servings: 2,
    steps: [{ text: '', imageId: randomUUID() }],
  };
  assert.equal(recipe.safeParse(body).success, true);
  assert.equal(recipe.safeParse({ ...body, steps: [{ text: '' }] }).success, false);
});

test('legacy migration retains recipes and inventory while converting featured collections', async (t) => {
  const db = await createDatabase({});
  t.after(() => db.close());
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of [
    '001_initial.sql',
    '002_subscriptions.sql',
    '003_indexes.sql',
    '004_notification_preferences.sql',
  ])
    for (const sql of (await readFile(new URL(name, folder), 'utf8'))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.query(sql);
  const uid = randomUUID(),
    fid = randomUUID(),
    special = randomUUID(),
    normal = randomUUID(),
    dish = randomUUID(),
    inv = randomUUID();
  await db.query('INSERT INTO users(id,nickname) VALUES($1,$2)', [uid, '升级前小猪']);
  await db.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [
    fid,
    '保留我的小家',
    uid,
  ]);
  await db.query('INSERT INTO members(family_id,user_id,role,identity) VALUES($1,$2,$3,$4)', [
    fid,
    uid,
    'cook',
    '猪大二',
  ]);
  await db.query('INSERT INTO collections(id,family_id,name) VALUES($1,$2,$3),($4,$2,$5)', [
    special,
    fid,
    '招牌',
    normal,
    '蔬菜',
  ]);
  await db.query(
    'INSERT INTO dishes(id,family_id,collection_id,name,minutes,servings) VALUES($1,$2,$3,$4,15,2)',
    [dish, fid, special, '旧拿手菜'],
  );
  await db.query('INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3)', [
    dish,
    '[]',
    JSON.stringify([{ text: '原来的做法' }]),
  ]);
  await db.query(
    'INSERT INTO inventories(id,user_id,name,quantity,unit,category) VALUES($1,$2,$3,1,$4,$5)',
    [inv, uid, '旧肉类食材', '斤', '肉类'],
  );
  for (const sql of (await readFile(new URL('005_dish_labels_inventory.sql', folder), 'utf8'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.query(sql);
  for (const sql of (await readFile(new URL('006_dish_collections.sql', folder), 'utf8'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.query(sql);
  assert.equal(
    (await db.query('SELECT collection_id FROM dish_collections WHERE dish_id=$1', [dish])).rows[0]
      .collection_id,
    normal,
  );
  const updated = (await db.query('SELECT * FROM dishes WHERE id=$1', [dish])).rows[0];
  assert.equal(updated.featured, true);
  assert.equal(updated.spice_level, 1);
  assert.equal(updated.collection_id, normal);
  assert.equal(
    (await db.query('SELECT steps FROM recipes WHERE dish_id=$1', [dish])).rows[0].steps[0].text,
    '原来的做法',
  );
  assert.equal(
    (await db.query('SELECT identity FROM members WHERE family_id=$1', [fid])).rows[0].identity,
    '猪大儿',
  );
  assert.equal(
    (await db.query('SELECT meat_type FROM inventories WHERE id=$1', [inv])).rows[0].meat_type,
    '其他',
  );
  assert.equal(
    (await db.query('SELECT version FROM families WHERE id=$1', [fid])).rows[0].version,
    2,
  );
});
