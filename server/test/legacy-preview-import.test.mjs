import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.mjs';

const dates = createRequire(import.meta.url)('../../miniprogram/lib/dates.js');
test('device preview recipes and read-only history import once without creating orders or achievements', async (t) => {
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
  const post = async (url, token, body) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: token ? { authorization: 'Bearer ' + token } : {},
      payload: body,
    });
    return { ...response.json(), status: response.statusCode };
  };
  const get = async (url, token) => {
    const response = await app.inject({ url, headers: { authorization: 'Bearer ' + token } });
    return { body: response.json(), status: response.statusCode };
  };
  const account = await post('/auth/register', null, {
    username: 'old_preview_owner',
    password: 'safe-password-2026',
  });
  await db.query("INSERT INTO identities(provider,subject,user_id) VALUES('wechat',$1,$2)", [
    'wechat-old-preview-test',
    account.user.id,
  ]);
  assert.equal((await get('/me/security', account.token)).body.wechatBound, true);
  assert.equal(
    (await post('/me/wechat/unbind', account.token, { currentPassword: 'wrong' })).status,
    403,
  );
  assert.equal((await get('/me/security', account.token)).body.wechatBound, true);
  assert.equal(
    (await post('/me/wechat/unbind', account.token, { currentPassword: 'safe-password-2026' }))
      .status,
    200,
  );
  assert.equal((await get('/me/security', account.token)).body.wechatBound, false);
  const other = await post('/auth/register', null, {
    username: 'other_owner',
    password: 'safe-password-2026',
  });
  const sourceId = 'preview-family-' + randomUUID();
  const groupId = 'preview-group-1';
  const yesterday = dates.shift(dates.today(), -1);
  const body = {
    sourceId,
    name: '找回来的小家',
    collections: [{ sourceId: groupId, name: '拿手好菜' }],
    dishes: [
      {
        sourceId: 'preview-dish-1',
        name: '番茄炒蛋',
        intro: '旧菜谱',
        collectionIds: [groupId],
        coverId: null,
        minutes: 15,
        servings: 2,
        featured: true,
        spiceLevel: 1,
        meatType: '',
        ingredients: [],
        steps: [],
      },
    ],
    inventory: [{ name: '番茄', quantity: 3, unit: '个', category: '蔬菜', meatType: '' }],
    history: [
      {
        date: yesterday,
        slot: '晚餐',
        name: '番茄炒蛋',
        coverId: null,
        quantity: 2,
        sources: [{ identity: '猪妈妈', quantity: 2 }],
        cookerLabel: '猪爸爸',
      },
      {
        date: dates.today(),
        slot: '午餐',
        name: '番茄炒蛋',
        coverId: null,
        quantity: 1,
        sources: [{ identity: '猪妈妈', quantity: 1 }],
        cookerLabel: null,
      },
    ],
  };
  const forged = await post('/me/legacy-imports', account.token, {
    ...body,
    dishes: [{ ...body.dishes[0], coverId: randomUUID() }],
  });
  assert.equal(forged.status, 400);
  assert.equal((await get('/families', account.token)).body.length, 0);
  const imported = await post('/me/legacy-imports', account.token, body);
  assert.equal(imported.status, 200, JSON.stringify(imported));
  const repeated = await post('/me/legacy-imports', account.token, body);
  assert.deepEqual(
    { id: repeated.id, alreadyImported: repeated.alreadyImported },
    { id: imported.id, alreadyImported: true },
  );
  const base = '/families/' + imported.id;
  assert.equal((await get('/families', account.token)).body.length, 1);
  assert.equal((await get(base + '/menu', account.token)).body.dishes[0].name, '番茄炒蛋');
  assert.equal((await get(base + '/inventory', account.token)).body[0].name, '番茄');
  assert.equal((await get(base + '/meals?date=' + yesterday, account.token)).body.dishes.length, 0);
  const history = (await get(base + '/history?date=' + yesterday, account.token)).body;
  assert.equal(history.dishes[0].legacy, true);
  assert.equal(history.dishes[0].sources[0].identity, '猪妈妈');
  assert.equal(history.dishes[0].cooker.identity, '猪爸爸');
  assert.equal(
    (await get(base + '/history?date=' + dates.today(), account.token)).body.dishes.length,
    0,
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM legacy_history WHERE family_id=$1', [
        imported.id,
      ])
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await get(
        base + '/meal-dates?from=' + yesterday + '&to=' + yesterday + '&history=1',
        account.token,
      )
    ).body.length,
    1,
  );
  assert.equal((await get(base + '/history?date=' + yesterday, other.token)).status, 404);
  assert.deepEqual((await get('/me/achievements', account.token)).body, {
    cooked: 0,
    ordered: 0,
    families: [{ id: imported.id, name: body.name, role: 'cook', cooked: 0, ordered: 0 }],
  });
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM orders WHERE family_id=$1', [imported.id]))
      .rows[0].n,
    0,
  );
});
