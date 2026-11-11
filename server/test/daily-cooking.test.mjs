import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { buildApp } from '../src/app.mjs';
import { createDatabase } from '../src/core/db.mjs';
import { queueCookingReminders } from '../src/modules/meals/cooking.mjs';
import { pruneHistory } from '../src/jobs/retention.mjs';
test('closed-day final menu settlement, exclusive cooking claims and stale reminders are consistent', async (t) => {
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
  let ip = 1;
  async function call(method, url, u, payload) {
    const r = await app.inject({
      method,
      url,
      payload,
      remoteAddress: '127.0.0.' + ip++,
      headers: u ? { authorization: 'Bearer ' + u.token, 'idempotency-key': randomUUID() } : {},
    });
    return Object.assign(r.json(), { status: r.statusCode });
  }
  const a = await call('POST', '/auth/register', null, {
      username: 'daily_cook_a',
      password: 'daily-password-123',
    }),
    b = await call('POST', '/auth/register', null, {
      username: 'daily_cook_b',
      password: 'daily-password-123',
    }),
    e = await call('POST', '/auth/register', null, {
      username: 'daily_eater',
      password: 'daily-password-123',
    });
  const f = await call('POST', '/families', a, { name: '每天的饭桌' }),
    base = '/families/' + f.id;
  for (const [u, role] of [
    [b, 'cook'],
    [e, 'eater'],
  ]) {
    const inv = await call('POST', base + '/invitations', a, { role });
    await call('POST', '/invitations/' + inv.token + '/accept', u, {});
  }
  const collectionId = (await call('GET', base + '/menu', a)).collections[0].id,
    ds = [];
  for (let i = 0; i < 4; i++)
    ds.push(
      (
        await call('POST', base + '/dishes', a, {
          name: '菜' + i,
          minutes: 5,
          servings: 2,
          collectionId,
        })
      ).id,
    );
  const date = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS date"))
    .rows[0].date;
  const yesterday = (
    await db.query("SELECT ((now() AT TIME ZONE 'Asia/Shanghai')::date-1)::text AS date")
  ).rows[0].date;
  const o = await call('POST', base + '/orders', e, {
    date,
    slot: '晚餐',
    items: [
      { dishId: ds[0], quantity: 2 },
      { dishId: ds[1], quantity: 3 },
      { dishId: ds[2], quantity: 1 },
    ],
  });
  await call('POST', base + '/orders/' + o.id + '/reply', a, { decision: 'accept' });
  const pending = await call('POST', base + '/orders', e, {
    date,
    slot: '早餐',
    items: [{ dishId: ds[0], quantity: 9 }],
  });
  const claim = { date, slot: '晚餐', dishId: ds[0], done: true };
  assert.equal((await call('POST', base + '/cooking-claims', a, claim)).status, 200);
  assert.equal((await call('POST', base + '/cooking-claims', b, claim)).status, 409);
  assert.equal((await call('GET', '/me/achievements', a)).cooked, 0);
  assert.equal((await call('GET', '/me/achievements', e)).ordered, 0);
  // Before the day ends, replace the second dish. Only the final replacement is settled.
  const line = (await call('GET', base + '/my-lines', e)).find((l) => l.dish_id === ds[1]);
  const change = await call('POST', base + '/changes', e, {
    lineId: line.id,
    replacementId: ds[3],
  });
  assert.equal(change.status, 200);
  await call('POST', base + '/changes/' + change.id + '/reply', a, { decision: 'accept' });
  await db.query('UPDATE orders SET meal_date=$1 WHERE family_id=$2', [yesterday, f.id]);
  await db.query('UPDATE cooking_records SET meal_date=$1 WHERE family_id=$2', [yesterday, f.id]);
  await queueCookingReminders(db);
  await queueCookingReminders(db);
  assert.equal((await call('GET', '/me/achievements', a)).cooked, 1);
  assert.equal((await call('GET', '/me/achievements', e)).ordered, 6);
  assert.equal(
    (await call('POST', base + '/orders/' + pending.id + '/reply', a, { decision: 'accept' }))
      .status,
    409,
  );
  const notesA = await call('GET', '/notifications', a),
    notesB = await call('GET', '/notifications', b);
  assert.equal(
    (await call('GET', '/notifications', e)).filter((n) => n.type === 'cooking.reminder').length,
    0,
  );
  const rems = (await db.query('SELECT * FROM cooking_reminders WHERE family_id=$1', [f.id])).rows;
  assert.equal(rems.length, 2);
  assert.ok(rems.every((r) => r.dish_id !== ds[0] && r.dish_id !== ds[1]));
  const target = rems.find((r) => r.dish_id === ds[3]);
  assert.ok(notesA.some((n) => n.entity_id === target.id));
  assert.ok(notesB.some((n) => n.entity_id === target.id));
  const race = await Promise.all([
    call('POST', base + '/cooking-claims', a, { ...claim, date: yesterday, dishId: ds[3] }),
    call('POST', base + '/cooking-claims', b, { ...claim, date: yesterday, dishId: ds[3] }),
  ]);
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? a : b,
    loser = winner === a ? b : a;
  const detail = await call('GET', base + '/cooking-reminders/' + target.id, loser);
  assert.equal(detail.claimable, false);
  assert.equal(detail.cooker.userId, winner.user.id);
  assert.equal(
    (
      await call('POST', base + '/cooking-claims', winner, {
        ...claim,
        date: yesterday,
        dishId: ds[3],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('POST', base + '/cooking-claims', winner, {
        ...claim,
        date: yesterday,
        dishId: ds[3],
        done: false,
      })
    ).status,
    409,
  );
  const statsA = await call('GET', '/me/achievements', a),
    statsB = await call('GET', '/me/achievements', b);
  assert.equal(statsA.cooked + statsB.cooked, 2, 'unclaimed third dish credits nobody');
  const history = await call('GET', base + '/history?date=' + yesterday, e);
  assert.equal(history.dishes.find((d) => d.dishId === ds[3]).cooker.userId, winner.user.id);
  assert.equal(history.dishes.find((d) => d.dishId === ds[2]).cooker, null);
  assert.ok(history.dishes.every((d) => d.sources[0].userId === e.user.id));
  const resolved = (await call('GET', '/notifications', loser)).filter(
    (n) => n.entity_id === target.id,
  );
  assert.ok(resolved.every((n) => n.invalidated_at && n.read_at));
  await db.query(
    "UPDATE orders SET meal_date=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '4 months' WHERE family_id=$1",
    [f.id],
  );
  await db.query(
    "UPDATE cooking_records SET meal_date=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '4 months' WHERE family_id=$1",
    [f.id],
  );
  await pruneHistory(db);
  await pruneHistory(db);
  assert.equal((await call('GET', '/me/achievements', e)).ordered, 6);
  assert.equal(
    (await call('GET', '/me/achievements', a)).cooked +
      (await call('GET', '/me/achievements', b)).cooked,
    2,
  );
});
test('upgrade preserves conflicting legacy cooking entries without assigning an arbitrary owner', async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(folder)).filter((f) => /^00[1-7]_/.test(f)).sort())
    for (const sql of (await readFile(new URL(file, folder), 'utf8'))
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean))
      await db.query(sql);
  const a = randomUUID(),
    b = randomUUID(),
    f = randomUUID(),
    c = randomUUID(),
    d = randomUUID();
  for (const id of [a, b]) await db.query('INSERT INTO users(id) VALUES($1)', [id]);
  await db.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [f, '旧记录', a]);
  await db.query('INSERT INTO collections(id,family_id,name) VALUES($1,$2,$3)', [c, f, '旧合集']);
  await db.query('INSERT INTO dishes(id,family_id,collection_id,name) VALUES($1,$2,$3,$4)', [
    d,
    f,
    c,
    '旧菜',
  ]);
  for (const u of [a, b])
    await db.query(
      "INSERT INTO cooking_records(family_id,user_id,meal_date,slot,dish_id) VALUES($1,$2,current_date,'晚餐',$3)",
      [f, u, d],
    );
  for (const sql of (await readFile(new URL('008_daily_cooking_claims.sql', folder), 'utf8'))
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean))
    await db.query(sql);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM cooking_records_legacy')).rows[0].n,
    2,
  );
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cooking_records')).rows[0].n, 0);
});
